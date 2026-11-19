// Some application URLs land on the job description, with the form one page further behind an
// "Apply" link. The extension follows that link by navigating to its address, the way typing it
// into the address bar would. It never clicks it: a link is a plain page load and can't send
// anything, while an "Apply" *button* might submit, so buttons are never followed.

/** Job sites the extension fills by itself. */
const ATS_HOSTS =
  /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|myworkdaysite\.com|smartrecruiters\.com|icims\.com)$/;

const APPLY_TEXT =
  /^(apply|apply now|apply here|apply online|apply for this (job|position|role|internship)|start (your |an |my )?application|i'?m interested)$/i;

const site = (host: string) => host.split(".").slice(-2).join(".");

/**
 * The address of the page's "Apply" link, when the form isn't on this page: a link (not a button)
 * whose text is just "Apply" or close to it, to an http(s) page on the same site or a job site
 * the extension knows. Null when there is no such link, or more than one destination.
 */
export function findApplyLink(doc: Document, here: URL): string | null {
  const found = new Set<string>();
  for (const a of doc.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const text = (a.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!APPLY_TEXT.test(text) && !APPLY_TEXT.test(a.getAttribute("aria-label") ?? "")) continue;
    let to: URL;
    try {
      to = new URL(a.getAttribute("href")!, here);
    } catch {
      continue;
    }
    if (to.protocol !== "https:" && to.protocol !== "http:") continue; // never javascript: or mailto:
    if (to.href.split("#")[0] === here.href.split("#")[0]) continue; // an anchor on this page
    if (site(to.hostname) !== site(here.hostname) && !ATS_HOSTS.test(to.hostname)) continue;
    found.add(to.href);
  }
  return found.size === 1 ? [...found][0]! : null;
}
