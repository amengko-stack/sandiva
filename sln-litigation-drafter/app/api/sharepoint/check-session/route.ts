import { NextRequest, NextResponse } from "next/server";
import { listAiFolder } from "@/lib/graph-client";
import type { CaseAnalysis, InterviewAnswer } from "@/types";

export const maxDuration = 30;

type Stage2Resume = {
  type: "file_list" | "categorization" | "extraction_progress";
  timestamp: string;
  // file_list
  files?: unknown[];
  // categorization
  docMap?: unknown[];
  selectedFileIds?: string[];
  // extraction_progress
  completedFiles?: unknown[];
  remainingFiles?: unknown[];
  processed?: number;
  totalChars?: number;
};

type CheckSessionResponse = {
  found: boolean;
  latestTimestamp?: string;
  analysis?: CaseAnalysis;
  kronologi?: string;
  interviewAnswers?: InterviewAnswer[];
  strategicAssessment?: string;
  resumeAtStage?: 3 | 4;
  resumeAtSubstep?: "3A" | "3B" | "3C";
  stage2Resume?: Stage2Resume;
  allFiles?: unknown[];
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

    // ── Stage 3 artifacts ────────────────────────────────────────────────────
    const analysisFile = latestFile(files, "analysis_");
    const kronoFile = latestFile(files, "kronologi_");
    const interviewFile = latestFile(files, "interview_");
    const assessmentFile = latestFile(files, "strategic_assessment_");

    // ── Stage 2 artifacts ────────────────────────────────────────────────────
    const progressFile = latestFile(files, "extraction_progress_");
    const categorizationFile = latestFile(files, "categorization_");
    const fileListFile = latestFile(files, "file_list_");

    const hasAnyArtifact = !!(analysisFile || progressFile || categorizationFile || fileListFile);
    if (!hasAnyArtifact) {
      return NextResponse.json({ found: false } satisfies CheckSessionResponse);
    }

    // ── Resolve Stage 2 resume (highest priority wins) ───────────────────────
    let stage2Resume: Stage2Resume | undefined;

    if (progressFile) {
      const data = await downloadJson(progressFile.downloadUrl) as Record<string, unknown> | null;
      if (data) {
        stage2Resume = {
          type: "extraction_progress",
          timestamp: progressFile.lastModified,
          docMap: (data.docMap as unknown[]) ?? [],
          completedFiles: (data.completedFiles as unknown[]) ?? [],
          remainingFiles: (data.remainingFiles as unknown[]) ?? [],
          processed: (data.processed as number) ?? 0,
          totalChars: (data.totalChars as number) ?? 0,
        };
      }
    } else if (categorizationFile) {
      const data = await downloadJson(categorizationFile.downloadUrl) as Record<string, unknown> | null;
      if (data) {
        stage2Resume = {
          type: "categorization",
          timestamp: categorizationFile.lastModified,
          docMap: (data.docMap as unknown[]) ?? [],
          selectedFileIds: (data.selectedFileIds as string[]) ?? [],
        };
      }
    } else if (fileListFile) {
      const data = await downloadJson(fileListFile.downloadUrl) as Record<string, unknown> | null;
      if (data) {
        stage2Resume = {
          type: "file_list",
          timestamp: fileListFile.lastModified,
          files: (data.files as unknown[]) ?? [],
        };
      }
    }

    // ── Always include the file list (needed to restore allFiles on resume) ──
    let allFiles: unknown[] | undefined;
    if (fileListFile) {
      const flData = await downloadJson(fileListFile.downloadUrl) as { files?: unknown[] } | null;
      if (flData?.files?.length) allFiles = flData.files;
    }

    // ── If no Stage 3 analysis, return Stage 2 resume only ──────────────────
    if (!analysisFile) {
      const latestTimestamp = stage2Resume?.timestamp ?? "";
      return NextResponse.json({
        found: true,
        latestTimestamp,
        stage2Resume,
        allFiles,
      } satisfies CheckSessionResponse);
    }

    // ── Stage 3 resolution ───────────────────────────────────────────────────
    const analysisData = await downloadJson(analysisFile.downloadUrl) as { analysis: CaseAnalysis } | null;
    const kronoData = kronoFile ? await downloadJson(kronoFile.downloadUrl) as { kronologi: string } | null : null;
    const interviewData = interviewFile ? await downloadJson(interviewFile.downloadUrl) as { answers: InterviewAnswer[] } | null : null;
    const assessmentData = assessmentFile ? await downloadJson(assessmentFile.downloadUrl) as { assessment: string } | null : null;

    const hasKronologi = !!kronoData?.kronologi;
    const hasInterview = !!interviewData?.answers;
    const hasAssessment = !!assessmentData?.assessment;

    // Furthest-artifact order: interview → 3C, kronologi → 3B, analysis → 3A
    let resumeAtSubstep: "3A" | "3B" | "3C" = "3A";
    if (hasInterview) resumeAtSubstep = "3C";
    else if (hasKronologi) resumeAtSubstep = "3B";

    const resumeAtStage: 3 | 4 = hasAssessment ? 4 : 3;

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
      stage2Resume,
      allFiles,
    } satisfies CheckSessionResponse);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Gagal memeriksa sesi sebelumnya";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
