import type { NextConfig } from "next";

const dev = process.env.NODE_ENV !== "production";
const httpsOnly = process.env.VERCEL === "1" || (process.env.APP_URL ?? "").startsWith("https://");

// Strict-as-practical CSP. Next.js needs inline scripts for hydration ('unsafe-inline'); everything else is locked to
// this origin, plus Unsplash images. frame-ancestors 'none' blocks clickjacking.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://images.unsplash.com https://cdn.simpleicons.org",
  "font-src 'self' data:",
  `connect-src 'self'${dev ? " ws: wss:" : ""}`,
  // the Assistant's side browser shows sites (yours and the links it gives you) in a sandboxed frame
  "frame-src 'self' https:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  ...(httpsOnly ? ["upgrade-insecure-requests"] : []),
].join("; ");

// Split deployment: when BACKEND_URL is set (the Vercel front end), every API call and /go link is served by the
// backend (Render), which owns the data, the schedule and the SSH connections to the machines. The browser only
// ever talks to this site, so sign-in cookies and the origin stay the same.
const backend = (process.env.BACKEND_URL ?? "").replace(/\/$/, "");

const nextConfig: NextConfig = {
  async rewrites() {
    if (!backend) return [];
    return {
      beforeFiles: [
        { source: "/api/:path*", destination: `${backend}/api/:path*` },
        { source: "/go/:name", destination: `${backend}/go/:name` },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
  // a second build folder lets one checkout run as both front end and backend (local testing)
  distDir: process.env.NEXT_DIST_DIR || ".next",
  cacheComponents: true,
  partialPrefetching: true,
  // ssh2 ships optional native addons; load it from node_modules at runtime instead of bundling it.
  serverExternalPackages: ["ssh2", "nodemailer"],
  poweredByHeader: false,
  async headers() {
    return [
      {
        // everything except attachment files: never framed by anyone
        source: "/((?!api/attachments).*)",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
      {
        // attachment files: the preview panel shows PDFs in a frame on this site only; nothing in them can run
        source: "/api/attachments",
        headers: [
          { key: "Content-Security-Policy", value: "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
