"use client";

import { useDD } from "@/context/DDContext";
import DDStage1Setup from "@/components/dd/DDStage1Setup";
import DDStage2Extract from "@/components/dd/DDStage2Extract";
import DDStage3Classify from "@/components/dd/DDStage3Classify";
import DDStage4Tables from "@/components/dd/DDStage4Tables";
import DDStage5Review from "@/components/dd/DDStage5Review";
import DDStage6Export from "@/components/dd/DDStage6Export";

export default function DDPage() {
  const { state } = useDD();
  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
      {state.error && (
        <div style={{ background: "#fee2e2", color: "#991b1b", padding: 12, borderRadius: 8, marginBottom: 16 }}>
          {state.error}
        </div>
      )}
      {state.stage === 1 && <DDStage1Setup />}
      {state.stage === 2 && <DDStage2Extract />}
      {state.stage === 3 && <DDStage3Classify />}
      {state.stage === 4 && <DDStage4Tables />}
      {state.stage === 5 && <DDStage5Review />}
      {state.stage === 6 && <DDStage6Export />}
    </div>
  );
}
