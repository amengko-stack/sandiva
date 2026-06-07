"use client";

import { useWorkflow } from "@/context/WorkflowContext";
import Stage1Select from "@/components/stages/Stage1Select";
import Stage2Files from "@/components/stages/Stage2Files";
import Stage3Analysis from "@/components/stages/Stage3Analysis";
import Stage4Draft from "@/components/stages/Stage4Draft";
import Stage5Output from "@/components/stages/Stage5Output";

export default function DrafterPage() {
  const { state } = useWorkflow();

  const stages = {
    1: <Stage1Select />,
    2: <Stage2Files />,
    3: <Stage3Analysis />,
    4: <Stage4Draft />,
    5: <Stage5Output />,
  };

  return (
    <div
      style={{
        maxWidth: 900,
        margin: "0 auto",
        padding: "36px 40px",
      }}
    >
      {stages[state.stage]}
    </div>
  );
}
