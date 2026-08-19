export type Stage1MetricType =
  | "publish_skipped"
  | "published"
  | "worker_completed"
  | "worker_duplicate"
  | "worker_retry"
  | "worker_dead_letter";

export interface Stage1Metric {
  type: Stage1MetricType;
  occurredAt: string;
  correlationId?: string;
  tenantKey?: string;
  fileClass?: "docx" | "txt";
  attempt?: number;
  errorCode?: "pointer_mismatch" | "stage0_failure" | "timeout";
}

export type Stage1MetricEmitter = (metric: Stage1Metric) => void;
