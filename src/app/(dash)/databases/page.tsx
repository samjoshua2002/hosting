import { redirect } from "next/navigation";

/** Databases now live on the Services page. */
export default function DatabasesPage() {
  redirect("/services");
}
