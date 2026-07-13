import { DDProvider } from "@/context/DDContext";
import DDSidebar from "@/components/dd/DDSidebar";

export default function DDLayout({ children }: { children: React.ReactNode }) {
  return (
    <DDProvider>
      <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>
        <DDSidebar />
        <main style={{ flex: 1, overflowY: "auto", background: "var(--bg-primary)" }}>{children}</main>
      </div>
    </DDProvider>
  );
}
