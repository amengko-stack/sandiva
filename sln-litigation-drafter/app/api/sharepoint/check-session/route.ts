import { NextRequest, NextResponse } from "next/server";
import { listAiFolder } from "@/lib/graph-client";
import type { CaseAnalysis, InterviewAnswer } from "@/types";

export const maxDuration = 30;

type CheckSessionResponse = {
  found: boolean;
  latestTimestamp?: string;
  analysis?: CaseAnalysis;
  kronologi?: string;
  interviewAnswers?: InterviewAnswer[];
  strategicAssessment?: string;
  resumeAtStage?: 3 | 4;
  resumeAtSubstep?: "3A" | "3B" | "3C";
};

async function downloadJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

function latestFile(files: { name: string; downloadUrl: string; lastModified: string }[], prefix: string) {
  const matching = files.filter((f) => f.name.startsWith(prefix) && f.name.endsWith(".json"));
  if (matching.length === 0) return null;
  return matching.sort((a, b) => b.lastModified.localeCompare(a.lastModified))[0];
}

export async function POST(req: NextRequest) {
  try {
    const { folderPath } = (await req.json()) as { folderPath: string };
    if (!folderPath) {
      return NextResponse.json({ error: "folderPath wajib diisi" }, { status: 400 });
    }

    const files = await listAiFolder(folderPath);
    if (files.length === 0) {
      return NextResponse.json({ found: false } satisfies CheckSessionResponse);
    }

    const analysisFile = latestFile(files, "analysis_");
    const kronoFile = latestFile(files, "kronologi_");
    const interviewFile = latestFile(files, "interview_");
    const assessmentFile = latestFile(files, "strategic_assessment_");

    if (!analysisFile) {
      return NextResponse.json({ found: false } satisfies CheckSessionResponse);
    }

    const analysisData = await downloadJson(analysisFile.downloadUrl) as { analysis: CaseAnalysis } | null;
    const kronoData = kronoFile ? await downloadJson(kronoFile.downloadUrl) as { kronologi: string } | null : null;
    const interviewData = interviewFile ? await downloadJson(interviewFile.downloadUrl) as { answers: InterviewAnswer[] } | null : null;
    const assessmentData = assessmentFile ? await downloadJson(assessmentFile.downloadUrl) as { assessment: string } | null : null;

    const hasKronologi = !!kronoData?.kronologi;
    const hasInterview = !!interviewData?.answers;
    const hasAssessment = !!assessmentData?.assessment;

    let resumeAtSubstep: "3A" | "3B" | "3C" = "3A";
    if (hasKronologi && hasInterview && hasAssessment) resumeAtSubstep = "3C";
    else if (hasKronologi && hasInterview) resumeAtSubstep = "3C";
    else if (hasKronologi) resumeAtSubstep = "3B";

    const resumeAtStage: 3 | 4 = (hasKronologi && hasInterview && hasAssessment) ? 4 : 3;

    const latestTimestamp = [analysisFile, kronoFile, interviewFile, assessmentFile]
      .filter(Boolean)
      .map((f) => f!.lastModified)
      .sort((a, b) => b.localeCompare(a))[0];

    return NextResponse.json({
      found: true,
      latestTimestamp,
      analysis: analysisData?.analysis,
      kronologi: kronoData?.kronologi,
      interviewAnswers: interviewData?.answers,
      strategicAssessment: assessmentData?.assessment,
      resumeAtStage,
      resumeAtSubstep,
    } satisfies CheckSessionResponse);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Gagal memeriksa sesi sebelumnya";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
