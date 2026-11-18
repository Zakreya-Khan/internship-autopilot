import type { ResumeDoc, ResumeEntry } from "@ia/core";
import PDFDocument from "pdfkit";

const MARGIN = 48;
const BODY = 10;
const SMALL = 9;

function collect(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}

function newDoc(title: string): PDFKit.PDFDocument {
  // Standard fonts only: they embed nothing and extract as clean text for ATS parsers.
  return new PDFDocument({
    size: "LETTER",
    margin: MARGIN,
    info: { Title: title },
    bufferPages: true,
  });
}

function sectionTitle(doc: PDFKit.PDFDocument, title: string): void {
  doc.moveDown(0.6).font("Helvetica-Bold").fontSize(11).text(title.toUpperCase());
  const y = doc.y + 1;
  doc
    .moveTo(MARGIN, y)
    .lineTo(doc.page.width - MARGIN, y)
    .lineWidth(0.5)
    .stroke();
  doc.moveDown(0.3);
}

function entry(doc: PDFKit.PDFDocument, e: ResumeEntry): void {
  const width = doc.page.width - 2 * MARGIN;
  const top = doc.y;
  doc
    .font("Helvetica-Bold")
    .fontSize(BODY)
    .text(e.heading, MARGIN, top, { width: width - 140 });
  if (e.dates)
    doc.font("Helvetica").fontSize(SMALL).text(e.dates, MARGIN, top, { width, align: "right" });
  if (e.subheading) doc.font("Helvetica-Oblique").fontSize(BODY).text(e.subheading, MARGIN);
  doc.font("Helvetica").fontSize(BODY);
  for (const b of e.bullets)
    doc.text(`•  ${b.text}`, MARGIN + 8, undefined, { width: width - 8, paragraphGap: 1 });
  doc.moveDown(0.3);
}

/** A one-column, ATS-friendly resume. */
export async function renderResumePdf(r: ResumeDoc): Promise<Buffer> {
  const doc = newDoc(`${r.header.name} - Resume`);
  const done = collect(doc);
  doc.font("Helvetica-Bold").fontSize(18).text(r.header.name, { align: "center" });
  const contact = [r.header.email, r.header.phone, r.header.city].filter(Boolean).join("  |  ");
  doc.font("Helvetica").fontSize(SMALL).text(contact, { align: "center" });
  if (r.header.links.length) doc.text(r.header.links.join("  |  "), { align: "center" });

  sectionTitle(doc, "Education");
  for (const e of r.education) {
    const top = doc.y;
    doc.font("Helvetica-Bold").fontSize(BODY).text(e.school, MARGIN, top);
    doc
      .font("Helvetica")
      .fontSize(SMALL)
      .text(`Expected ${e.grad}`, MARGIN, top, { align: "right" });
    doc
      .font("Helvetica")
      .fontSize(BODY)
      .text(`${e.degree} in ${e.major}${e.gpa ? `  |  GPA ${e.gpa}` : ""}`, MARGIN);
    if (e.courses.length) doc.fontSize(SMALL).text(`Relevant coursework: ${e.courses.join(", ")}`);
  }
  if (r.experience.length) {
    sectionTitle(doc, "Experience");
    for (const e of r.experience) entry(doc, e);
  }
  if (r.projects.length) {
    sectionTitle(doc, "Projects");
    for (const e of r.projects) entry(doc, e);
  }
  if (r.skills.length) {
    sectionTitle(doc, "Skills");
    doc.font("Helvetica").fontSize(BODY).text(r.skills.join(", "), MARGIN);
  }
  doc.end();
  return done;
}

export async function renderCoverLetterPdf(
  name: string,
  company: string,
  paragraphs: string[],
): Promise<Buffer> {
  const doc = newDoc(`${name} - Cover letter - ${company}`);
  const done = collect(doc);
  doc.font("Helvetica-Bold").fontSize(14).text(name);
  doc.moveDown(1).font("Helvetica").fontSize(11);
  doc.text(`Dear ${company} hiring team,`).moveDown(0.8);
  for (const p of paragraphs) doc.text(p, { align: "left", paragraphGap: 8 });
  doc.moveDown(0.5).text("Sincerely,").text(name);
  doc.end();
  return done;
}

export function pageCount(pdf: Buffer): number {
  return (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}
