import { RunDashboard } from "@/components/run-dashboard";

export default async function RunPage({ params }: PageProps<"/runs/[id]">) {
  const { id } = await params;
  return <RunDashboard id={id} />;
}
