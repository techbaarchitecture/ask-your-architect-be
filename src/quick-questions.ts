export const LOCALES = ["en", "es", "zh", "vi"] as const;
export type Locale = (typeof LOCALES)[number];
export type QuickQuestion = { title: string; question: string };
export type QuickQuestions = Record<Locale, QuickQuestion[]>;

export const DEFAULT_QUICK_QUESTIONS: QuickQuestions = {
  en: [
    {
      title: "Explore my space",
      question: "How can I make a small home feel more spacious?",
    },
    {
      title: "Plan my budget",
      question: "How should I plan the budget for a home renovation?",
    },
    {
      title: "Choose materials",
      question:
        "What should I consider when choosing sustainable building materials?",
    },
    {
      title: "Understand the process",
      question:
        "What are the stages of working with an architect on a new home?",
    },
  ],
  es: [
    {
      title: "Explorar mi espacio",
      question: "¿Cómo puedo hacer que una casa pequeña se sienta más amplia?",
    },
    {
      title: "Planear mi presupuesto",
      question: "¿Cómo debo planear el presupuesto de una reforma?",
    },
    {
      title: "Elegir materiales",
      question:
        "¿Qué debo considerar al elegir materiales de construcción sostenibles?",
    },
    {
      title: "Entender el proceso",
      question:
        "¿Cuáles son las etapas de trabajar con un arquitecto en una casa nueva?",
    },
  ],
  zh: [
    {
      title: "探索空间",
      question: "怎样让小户型住得更宽敞？",
    },
    {
      title: "规划预算",
      question: "家庭翻新应该如何规划预算？",
    },
    {
      title: "选择材料",
      question: "选择可持续建材时要注意什么？",
    },
    {
      title: "了解流程",
      question: "和建筑师一起做新房，一般有哪些阶段？",
    },
  ],
  vi: [
    {
      title: "Khám phá không gian",
      question: "Làm sao để nhà nhỏ vẫn cảm thấy rộng rãi?",
    },
    {
      title: "Lên ngân sách",
      question: "Nên lập ngân sách cải tạo nhà như thế nào?",
    },
    {
      title: "Chọn vật liệu",
      question: "Cần lưu ý gì khi chọn vật liệu xây dựng bền vững?",
    },
    {
      title: "Hiểu quy trình",
      question:
        "Các giai đoạn làm việc với kiến trúc sư khi xây nhà mới là gì?",
    },
  ],
};

export function normalizeQuickQuestions(raw: unknown): QuickQuestions {
  const next: QuickQuestions = {
    en: DEFAULT_QUICK_QUESTIONS.en.map((item) => ({ ...item })),
    es: DEFAULT_QUICK_QUESTIONS.es.map((item) => ({ ...item })),
    zh: DEFAULT_QUICK_QUESTIONS.zh.map((item) => ({ ...item })),
    vi: DEFAULT_QUICK_QUESTIONS.vi.map((item) => ({ ...item })),
  };
  if (!raw || typeof raw !== "object") return next;
  const record = raw as Record<string, unknown>;
  for (const locale of LOCALES) {
    const list = record[locale];
    if (!Array.isArray(list)) continue;
    for (let i = 0; i < 4; i++) {
      const item = list[i];
      if (!item || typeof item !== "object") continue;
      const title = String((item as QuickQuestion).title ?? "").trim();
      const question = String((item as QuickQuestion).question ?? "").trim();
      if (title) next[locale][i].title = title.slice(0, 80);
      if (question) next[locale][i].question = question.slice(0, 500);
    }
  }
  return next;
}
