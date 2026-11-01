export const VARIANT_IN_TRASH = "variant in trash";
export const PAGE_HIDDEN = "Page is restricted or unavailable";
export const NOT_ALLOWED = "Not allowed";
export const WORKSPACE_HIDDEN = "Workspace is restricted or unavailable";

export const languageChoices = [
  { tag: "en", name: "English", label: "EN" },
  { tag: "hi", name: "Hindi", label: "हिन्दी" },
  { tag: "bn", name: "Bengali", label: "বাংলা" },
  { tag: "ta", name: "Tamil", label: "தமிழ்" },
  { tag: "te", name: "Telugu", label: "తెలుగు" },
  { tag: "mr", name: "Marathi", label: "मराठी" },
  { tag: "gu", name: "Gujarati", label: "ગુજરાતી" },
  { tag: "pa", name: "Punjabi", label: "ਪੰਜਾਬੀ" },
  { tag: "ur", name: "Urdu", label: "اردو" },
  { tag: "ar", name: "Arabic", label: "العربية" },
  { tag: "es", name: "Spanish", label: "ES" },
  { tag: "fr", name: "French", label: "FR" },
  { tag: "de", name: "German", label: "DE" },
  { tag: "pt", name: "Portuguese", label: "PT" },
  { tag: "zh", name: "Chinese", label: "中文" },
  { tag: "ja", name: "Japanese", label: "日本語" },
  { tag: "ko", name: "Korean", label: "한국어" },
] as const;

const catalog = new Map<string, (typeof languageChoices)[number]>(languageChoices.map(item => [item.tag, item]));

export function canonicalLanguage(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 35) return null;
  try {
    const [tag] = Intl.getCanonicalLocales(trimmed);
    if (!tag || tag.length > 35 || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/.test(tag)) return null;
    return tag;
  } catch {
    return null;
  }
}

export function languageName(tag: string) {
  return catalog.get(tag.split("-")[0])?.name ?? tag;
}

export function languageLabel(tag: string) {
  const primary = tag.split("-")[0];
  const known = catalog.get(primary);
  if (!known) return tag;
  if (!tag.includes("-")) return known.label;
  return `${known.label}-${tag.slice(primary.length + 1)}`;
}

export function variantBannerMessage(label: string) {
  return `A ${label} version of this document is available.`;
}

export function variantStayLabel(sourceLanguage: string) {
  return `Stay on ${languageName(sourceLanguage)}`;
}

export function staleBadge(sourceLanguage: string, syncedVersion: number | null, sourceVersion: number) {
  const from = syncedVersion == null ? "unsynced" : `v${syncedVersion}`;
  return `Behind ${languageName(sourceLanguage)} source (${from} → v${sourceVersion})`;
}

export type VariantRouting = "banner" | "auto";
export type VariantOption = { language: string; pageId: string };
export type VariantRedirect = { pageId: string; language: string; remember: boolean };

export function variantRoute(input: {
  routing: VariantRouting;
  profileLanguage: string | null;
  remembered: string | null;
  currentLanguage: string | null;
  options: VariantOption[];
}): { redirectTo: VariantRedirect | null; bannerLanguage: string | null } {
  if (input.remembered === "source") return { redirectTo: null, bannerLanguage: null };
  const preferred = input.remembered && input.remembered !== "source" ? input.remembered : input.profileLanguage;
  if (!preferred || preferred === input.currentLanguage) return { redirectTo: null, bannerLanguage: null };
  const match = input.options.find(option => option.language === preferred);
  if (!match) return { redirectTo: null, bannerLanguage: null };
  if (input.routing === "auto" || input.remembered === preferred) {
    return { redirectTo: { pageId: match.pageId, language: match.language, remember: input.remembered !== preferred }, bannerLanguage: null };
  }
  return { redirectTo: null, bannerLanguage: match.language };
}

export function publicationLineDiff(before: string, after: string) {
  const afterLines = after.split("\n").map(line => line.trim()).filter(Boolean);
  const beforeLines = new Set(before.split("\n").map(line => line.trim()).filter(Boolean));
  const added = afterLines.filter(line => !beforeLines.has(line)).slice(0, 12).map(line => line.slice(0, 160));
  const afterSet = new Set(afterLines);
  const removedCount = [...beforeLines].filter(line => !afterSet.has(line)).length;
  return { added, removedCount };
}
