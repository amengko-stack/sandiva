export interface EntryRowData {
  id: number;
  date: string;
  units: string;
  workcode: string;
  description: string;
  status: "draft" | "submitted" | "approved" | "billed";
  matterCode: string;
  matterTitle: string;
  clientName: string;
  currency: string;
  partnerInitials: string;
}

const PILL: Record<EntryRowData["status"], string> = {
  draft: "bg-[var(--surface-3)] text-[var(--text-2)]",
  submitted: "bg-[var(--navy)]/10 text-[var(--navy)] dark:bg-[#6ea0b9]/20 dark:text-[#9cc4d6]",
  approved: "bg-good/15 text-good",
  billed: "bg-plum/15 text-plum",
};

export function EntryRow({ entry, children }: { entry: EntryRowData; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-[var(--border)] px-4 py-2.5 hover:bg-[var(--surface-2)]">
      <span className="min-w-[74px] flex-none rounded-full bg-[var(--surface-3)] px-2 py-0.5 text-center text-[10.5px] font-bold text-[var(--text-2)]">
        {entry.workcode}
      </span>
      <span className="num flex-none text-xs text-[var(--text-3)]">{entry.date}</span>
      <span className="num ml-auto flex-none font-bold">{Number(entry.units).toFixed(2)}</span>
      <span className={`flex-none rounded-full px-2 py-0.5 text-[10.5px] font-bold capitalize ${PILL[entry.status]}`}>
        {entry.status}
      </span>
      <div className="order-last w-full min-w-0">
        <div className="text-[13.5px]">{entry.description}</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-[var(--text-3)]">
          <span className="truncate">
            {entry.clientName} · {entry.matterCode} · {entry.matterTitle}
          </span>
          <span
            className="grid h-5 w-5 flex-none place-items-center rounded-full border border-[var(--border)] bg-[var(--surface-3)] text-[8.5px] font-bold text-[var(--text-2)]"
            title={`Approval routes to engagement partner ${entry.partnerInitials}`}
          >
            {entry.partnerInitials}
          </span>
          <span className="flex-none rounded border border-[var(--border)] px-1 text-[9.5px] font-bold text-[var(--text-3)]">
            {entry.currency}
          </span>
        </div>
      </div>
      {children}
    </div>
  );
}
