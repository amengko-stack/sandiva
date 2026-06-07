export interface DocTypeConfig {
  id: string;
  label: string;
  claimTypes: { id: string; label: string }[];
  hasPihak: boolean;
  promptKey: string;
}

export interface PracticeAreaConfig {
  id: string;
  label: string;
  docTypes: DocTypeConfig[];
}

const PMH_WANPRESTASI = [
  { id: "pmh", label: "Perbuatan Melawan Hukum (Pasal 1365 KUH Perdata)" },
  { id: "wanprestasi", label: "Wanprestasi (Pasal 1243 KUH Perdata)" },
];

export const PRACTICE_AREAS: PracticeAreaConfig[] = [
  {
    id: "perdata",
    label: "Litigasi Perdata",
    docTypes: [
      {
        id: "gugatan",
        label: "Gugatan",
        claimTypes: PMH_WANPRESTASI,
        hasPihak: false,
        promptKey: "gugatan",
      },
      {
        id: "jawaban",
        label: "Jawaban",
        claimTypes: PMH_WANPRESTASI,
        hasPihak: false,
        promptKey: "jawaban",
      },
      {
        id: "replik",
        label: "Replik",
        claimTypes: PMH_WANPRESTASI,
        hasPihak: false,
        promptKey: "replik",
      },
      {
        id: "duplik",
        label: "Duplik",
        claimTypes: PMH_WANPRESTASI,
        hasPihak: false,
        promptKey: "duplik",
      },
      {
        id: "kesimpulan",
        label: "Kesimpulan",
        claimTypes: PMH_WANPRESTASI,
        hasPihak: true,
        promptKey: "kesimpulan",
      },
    ],
  },
  {
    id: "pkpu",
    label: "PKPU & Kepailitan",
    docTypes: [
      {
        id: "permohonan_pkpu",
        label: "Permohonan PKPU",
        claimTypes: [],
        hasPihak: false,
        promptKey: "permohonan_pkpu",
      },
      {
        id: "permohonan_pailit",
        label: "Permohonan Pailit",
        claimTypes: [],
        hasPihak: false,
        promptKey: "permohonan_pailit",
      },
      {
        id: "jawaban_pkpu",
        label: "Jawaban atas Permohonan PKPU/Pailit",
        claimTypes: [],
        hasPihak: false,
        promptKey: "jawaban_pkpu",
      },
      {
        id: "rencana_perdamaian",
        label: "Rencana Perdamaian",
        claimTypes: [],
        hasPihak: false,
        promptKey: "rencana_perdamaian",
      },
      {
        id: "kesimpulan_pkpu",
        label: "Kesimpulan PKPU/Kepailitan",
        claimTypes: [],
        hasPihak: true,
        promptKey: "kesimpulan_pkpu",
      },
    ],
  },
];

export function findDocType(
  practiceAreaId: string,
  docTypeId: string
): DocTypeConfig | undefined {
  const area = PRACTICE_AREAS.find((a) => a.id === practiceAreaId);
  return area?.docTypes.find((d) => d.id === docTypeId);
}

export function findPracticeArea(id: string): PracticeAreaConfig | undefined {
  return PRACTICE_AREAS.find((a) => a.id === id);
}

export const DOC_TYPE_CODES: Record<string, string> = {
  gugatan: "GUG",
  jawaban: "JAW",
  replik: "RPL",
  duplik: "DPL",
  kesimpulan: "KSP",
  permohonan_pkpu: "PKP",
  permohonan_pailit: "PAI",
  jawaban_pkpu: "JPK",
  rencana_perdamaian: "RPD",
  kesimpulan_pkpu: "KPK",
};

export function generateRef(docTypeId: string): string {
  const code = DOC_TYPE_CODES[docTypeId] || "DOC";
  const rand = Math.floor(Math.random() * 900) + 100;
  const year = new Date().getFullYear();
  return `SLN/${code}/${rand}/${year}`;
}
