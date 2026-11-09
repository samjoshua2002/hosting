"use client";

// The Assistant's state lives here, outside the page, so a run keeps streaming while you look at other
// pages. The server saves every session on box5 as it goes, so a closed tab or reload picks up where
// the run is (polling until it finishes).
import { useSyncExternalStore } from "react";
import { applyEvent, settle, type Att, type Item, type OperatorEvent } from "@/lib/assistant-items";

export interface Meta {
  id: string;
  title: string;
  updatedAt: number;
  running?: boolean;
  pinned?: boolean;
  named?: boolean;
  source?: "pipeline" | "autopilot";
}

export interface Doc {
  title: string;
  items: Item[];
  transcript: unknown[];
  files: Att[];
  /** this tab is streaming a run for it */
  busy: boolean;
  /** a run is going on the server that this tab isn't streaming (reload, other device): poll */
  remote: boolean;
  paused: boolean;
}

export interface AssistantState {
  current: string;
  docs: Record<string, Doc>;
  list: Meta[] | null;
  error: string | null;
  review: "auto" | "manual";
  /** "" = the default cloud model; Azure deployment name; or ollama/<service>/<model> */
  model: string;
}

const CACHE = "hosting.assistant.v2";
const REVIEW = "hosting.assistant.review";
const MODEL = "hosting.assistant.model";
export const newId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const empty = (): Doc => ({ title: "New session", items: [], transcript: [], files: [], busy: false, remote: false, paused: false });

const SERVER: AssistantState = { current: "s0000000000", docs: {}, list: null, error: null, review: "auto", model: "" };
let state: AssistantState = SERVER;
let hydrated = false;
const listeners = new Set<() => void>();
const streams = new Map<string, AbortController>();
const polls = new Set<string>();

function emit() {
  for (const l of listeners) l();
}

function set(patch: Partial<AssistantState>) {
  state = { ...state, ...patch };
  emit();
  try {
    const d = state.docs[state.current];
    if (d) sessionStorage.setItem(CACHE, JSON.stringify({ current: state.current, doc: { ...d, busy: false } }));
  } catch {
    /* storage full or blocked */
  }
}

function patchDoc(id: string, f: (d: Doc) => Doc) {
  set({ docs: { ...state.docs, [id]: f(state.docs[id] ?? empty()) } });
}

export function useAssistant(): AssistantState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => SERVER,
  );
}

/** True while any session runs (for the nav). */
export function useAssistantBusy(): boolean {
  const s = useAssistant();
  return Object.values(s.docs).some((d) => d.busy || d.remote);
}

export function currentDoc(s: AssistantState = state): Doc {
  return s.docs[s.current] ?? empty();
}

/** First visit in this tab: restore the open session and the review mode, then sync with box5. */
export function hydrate() {
  if (hydrated) return;
  hydrated = true;
  let current = newId();
  let doc = empty();
  let review: "auto" | "manual" = "auto";
  let model = "";
  try {
    const c = JSON.parse(sessionStorage.getItem(CACHE) ?? "null");
    if (c?.current && c.doc) {
      current = c.current;
      doc = { ...empty(), ...c.doc, busy: false, items: settle(c.doc.items ?? []) };
    }
    if (localStorage.getItem(REVIEW) === "manual") review = "manual";
    model = localStorage.getItem(MODEL) ?? "";
  } catch {
    /* nothing cached */
  }
  state = { ...state, current, docs: { [current]: doc }, review, model };
  emit();
  void loadList();
  if (doc.items.length) void refreshFromServer(current);
}

export async function loadList() {
  try {
    const r = await fetch("/api/sessions", { cache: "no-store" });
    if (r.status === 401) return void window.location.replace("/login");
    const d = await r.json();
    if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
    set({ list: d.sessions as Meta[], error: null });
  } catch (e) {
    set({ list: state.list ?? [], error: `History lives on box5: ${(e as Error).message}` });
  }
}

interface ServerDoc {
  id: string;
  title: string;
  items: Item[];
  transcript: unknown[];
  attachments?: Att[];
  running?: boolean;
}

/** Load a session from box5; if a run is still going there, follow it. */
async function refreshFromServer(id: string): Promise<boolean> {
  if (streams.has(id)) return true;
  const r = await fetch(`/api/sessions?id=${id}`, { cache: "no-store" });
  if (!r.ok) return false;
  const s = (await r.json()) as ServerDoc;
  if (streams.has(id)) return true; // a run started meanwhile
  patchDoc(id, (d) => ({
    ...d,
    title: s.title,
    items: s.running ? s.items : settle(s.items),
    transcript: s.transcript ?? [],
    files: s.attachments ?? d.files,
    remote: Boolean(s.running),
  }));
  if (s.running) startPolling(id);
  return true;
}

function startPolling(id: string) {
  if (polls.has(id)) return;
  polls.add(id);
  const tick = async () => {
    const d = state.docs[id];
    if (!d?.remote || streams.has(id)) {
      polls.delete(id);
      return;
    }
    await refreshFromServer(id).catch(() => {});
    if (state.docs[id]?.remote) setTimeout(tick, 3000);
    else {
      polls.delete(id);
      void loadList();
    }
  };
  setTimeout(tick, 3000);
}

export async function openSession(id: string) {
  if (id === state.current) return;
  set({ current: id, docs: state.docs[id] ? state.docs : { ...state.docs, [id]: empty() } });
  if (streams.has(id)) return; // live in this tab already
  try {
    if (!(await refreshFromServer(id))) set({ error: "Couldn't open that session" });
  } catch (e) {
    set({ error: (e as Error).message });
  }
}

export function newSession() {
  const id = newId();
  set({ current: id, docs: { ...state.docs, [id]: empty() } });
}

export async function removeSession(id: string) {
  await fetch(`/api/sessions?id=${id}`, { method: "DELETE" }).catch(() => {});
  if (id === state.current) newSession();
  void loadList();
}

/** Rename (title) or pin a session; the list updates right away. */
export async function editSession(id: string, edit: { title?: string; pinned?: boolean }) {
  const list = state.list ?? [];
  set({
    list: list
      .map((m) => (m.id === id ? { ...m, ...(edit.title ? { title: edit.title, named: true } : {}), ...(edit.pinned !== undefined ? { pinned: edit.pinned } : {}) } : m))
      .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt),
  });
  if (edit.title) patchDoc(id, (d) => ({ ...d, title: edit.title! }));
  const r = await fetch("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, rename: edit.title, pin: edit.pinned }) });
  if (!r.ok) void loadList();
}

export function setModel(model: string) {
  try {
    localStorage.setItem(MODEL, model);
  } catch {
    /* blocked */
  }
  set({ model });
}

export function setReview(review: "auto" | "manual") {
  try {
    localStorage.setItem(REVIEW, review);
  } catch {
    /* blocked */
  }
  set({ review });
}

/** A session's doc (any session, not only the open one). */
export function getDoc(id: string): Doc {
  return state.docs[id] ?? empty();
}

/** Make a session exist without opening it (the Pipeline's AI panel keeps its own). */
export function ensureDoc(id: string, title: string) {
  if (!state.docs[id]) set({ docs: { ...state.docs, [id]: { ...empty(), title } } });
}

/** Approve or decline an action; once nothing is pending, the run continues. */
export function decide(id: string, callId: string, ok: boolean) {
  updateItems(id, (x) => x.map((i) => (i.kind === "approval" && i.id === callId ? { ...i, decision: ok } : i)));
  const next = getDoc(id).items;
  if (!next.some((i) => i.kind === "approval" && i.decision === undefined)) {
    const approvals: Record<string, boolean> = {};
    for (const i of next) if (i.kind === "approval" && i.decision !== undefined) approvals[i.id] = i.decision;
    void send(id, { approvals });
  }
}

export function answer(id: string, callId: string, text: string) {
  updateItems(id, (x) => x.map((i) => (i.kind === "question" && i.id === callId ? { ...i, answer: text } : i)));
  void send(id, { answers: { [callId]: text } });
}

export function addFiles(id: string, files: Att[]) {
  patchDoc(id, (d) => ({ ...d, files: [...d.files, ...files] }));
}

export function updateItems(id: string, f: (items: Item[]) => Item[]) {
  patchDoc(id, (d) => ({ ...d, items: f(d.items) }));
}

export function setTitle(id: string, title: string) {
  patchDoc(id, (d) => ({ ...d, title }));
}

/** Start (or continue) a run for a session and stream it into the store. */
export async function send(
  id: string,
  body: { message?: string; display?: string; staged?: Att[]; approvals?: Record<string, boolean>; answers?: Record<string, string>; source?: "pipeline" },
) {
  if (streams.has(id)) return;
  const ctrl = new AbortController();
  streams.set(id, ctrl);
  let lost = false;
  patchDoc(id, (d) => ({ ...d, busy: true, remote: false, paused: false }));
  const d = state.docs[id];
  try {
    const res = await fetch("/api/ai/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // the server loads the session from box5 and applies just this change
      body: JSON.stringify({ session: id, title: d.title, files: d.files, review: state.review, model: state.model || undefined, ...body }),
      signal: ctrl.signal,
    });
    if (res.status === 401) return void window.location.replace("/login");
    if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error ?? `Request failed (${res.status})`);
    void loadList();
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const e = JSON.parse(line) as OperatorEvent;
        patchDoc(id, (x) => (e.type === "done" ? { ...x, transcript: e.transcript, paused: e.paused } : { ...x, items: applyEvent(x.items, e) }));
      }
      if (done) break;
    }
  } catch (e) {
    const err = e as Error;
    if (err.name === "AbortError") patchDoc(id, (x) => ({ ...x, items: [...x.items, { kind: "text", text: "Stopped." }] }));
    else if (err instanceof TypeError) lost = true; // connection dropped: the run carries on on the server
    else patchDoc(id, (x) => ({ ...x, items: [...x.items, { kind: "text", text: `⚠️ ${err.message}` }] }));
  } finally {
    streams.delete(id);
    patchDoc(id, (x) => ({ ...x, busy: false, remote: lost, items: lost ? x.items : settle(x.items) }));
    // box5 has the full picture (including anything this tab missed)
    void refreshFromServer(id).catch(() => {});
    void loadList();
  }
}

/** Stop a run: tell the server (it may be running without this tab), and stop listening. */
export async function stop(id: string) {
  await fetch("/api/ai/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session: id }) }).catch(() => {});
  streams.get(id)?.abort();
  patchDoc(id, (x) => ({ ...x, remote: false }));
}

/** Open a fresh chat and send it a first message right away (Investigate buttons, alerts). Returns the session id. */
export function startChat(message: string, display?: string): string {
  hydrate();
  newSession();
  const id = state.current;
  void send(id, { message, display: display ?? message });
  return id;
}
