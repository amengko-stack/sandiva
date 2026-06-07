import { WorkflowProvider } from "@/context/WorkflowContext";
import Sidebar from "@/components/Sidebar";

export default function DrafterLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <WorkflowProvider>
      <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>
        <Sidebar />
        <main
          style={{
            flex: 1,
            overflowY: "auto",
            background: "var(--bg-primary)",
          }}
        >
          {children}
        </main>
      </div>
    </WorkflowProvider>
  );
}
