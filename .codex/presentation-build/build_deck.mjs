import fs from "node:fs/promises";
import path from "node:path";
import { Presentation, PresentationFile } from "@oai/artifact-tool";

const root = "C:/Users/Kiko/OneDrive/Documents/Projects/InigoSync (Thesis)";
const buildDir = path.join(root, ".codex/presentation-build");
const renderDir = path.join(buildDir, "renders");
const logoPath = path.join(root, "assets/Logo/InigoSync-Wordmark.png");
const siteShotPath = path.join(root, "output/landing-controls-desktop.png");
const candidatePath = path.join(buildDir, "candidate.pptx");
const logoBytes = new Uint8Array(await fs.readFile(logoPath));
const siteShotBytes = new Uint8Array(await fs.readFile(siteShotPath));

const C = {
  bg: "#090909",
  band: "#111111",
  surface: "#191919",
  white: "#FFFFFF",
  muted: "#D0D0D0",
  soft: "#AFAFAF",
  border: "#343434",
  orange: "#FF7900",
  orangeLight: "#FF9A4A",
  black: "#111111",
};
const FONT = "Segoe UI";
const presentation = Presentation.create({ slideSize: { width: 1280, height: 720 } });

function addRect(slide, name, x, y, w, h, fill, lineFill = "none", lineWidth = 0, geometry = "rect") {
  return slide.shapes.add({
    geometry,
    name,
    position: { left: x, top: y, width: w, height: h },
    fill,
    line: { style: "solid", fill: lineFill, width: lineWidth },
  });
}

function addText(slide, name, text, x, y, w, h, options = {}) {
  return slide.shapes.add({
    geometry: "textbox",
    name,
    position: { left: x, top: y, width: w, height: h },
    fill: "none",
    line: { style: "solid", fill: "none", width: 0 },
    text: {
      text,
      style: {
        typeface: FONT,
        fontSize: options.fontSize ?? 24,
        bold: options.bold ?? false,
        color: options.color ?? C.white,
        alignment: options.alignment ?? "left",
        verticalAlignment: options.verticalAlignment ?? "top",
        autoFit: "shrinkText",
        wrap: "square",
        insets: 0,
      },
    },
  });
}

function addDot(slide, name, x, y, size = 10, color = C.orange) {
  return slide.shapes.add({
    geometry: "ellipse",
    name,
    position: { left: x, top: y, width: size, height: size },
    fill: color,
    line: { style: "solid", fill: "none", width: 0 },
  });
}

function contentSlide(title, slideNumber, background = C.bg) {
  const slide = presentation.slides.add({ background: { fill: background } });
  addText(slide, `slide-title-${slideNumber}`, title, 72, 50, 1136, 60, {
    fontSize: 44,
    bold: true,
    color: C.white,
  });
  addRect(slide, `title-rule-${slideNumber}`, 72, 126, 1136, 3, C.orange);
  return slide;
}

function addBullet(slide, name, text, x, y, width, height, fontSize = 22) {
  addDot(slide, `${name}-dot`, x, y + 10, 9);
  addText(slide, `${name}-text`, text, x + 26, y, width - 26, height, {
    fontSize,
    color: C.muted,
  });
}

function addNote(slide, lines) {
  slide.speakerNotes.text = lines;
  slide.speakerNotes.setVisible(true);
}

// 1. Cover
{
  const slide = presentation.slides.add({ background: { fill: C.bg } });
  addRect(slide, "cover-accent", 0, 0, 14, 720, C.orange);
  slide.images.add({
    blob: logoBytes,
    contentType: "image/png",
    alt: "IñigoSync wordmark",
    fit: "contain",
    position: { left: 80, top: 58, width: 420, height: 177 },
  });
  addText(slide, "cover-kicker", "FINAL DEFENSE", 80, 274, 420, 32, {
    fontSize: 22,
    bold: true,
    color: C.orange,
  });
  addText(
    slide,
    "project-title",
    "A Web-Based Booking\nManagement System",
    80,
    316,
    1030,
    126,
    { fontSize: 54, bold: true, color: C.white },
  );
  addText(slide, "cover-subtitle", "for Iñigos Sports Center", 80, 460, 940, 44, {
    fontSize: 30,
    color: C.muted,
  });
  addRect(slide, "cover-name-rule", 80, 528, 500, 2, C.border);
  addText(
    slide,
    "cover-authors-one",
    "Gilbert D. Lorca  ·  Christian Louis S. Oborza",
    80,
    549,
    900,
    28,
    { fontSize: 20, color: C.white },
  );
  addText(
    slide,
    "cover-authors-two",
    "Ken Paulo A. Olila  ·  Jaycob C. Villapando",
    80,
    581,
    900,
    28,
    { fontSize: 20, color: C.white },
  );
  addText(slide, "cover-school", "STI College Lucena  ·  November 2026", 80, 642, 700, 24, {
    fontSize: 18,
    color: C.soft,
  });
  addNote(slide, [
    "Open with the project title and introduce the four proponents.",
    "Recommended flow: problem and value → objectives and scope → technology and Agile method → short system demo → results and limits → questions.",
    "Source: capstone title page and abstract.",
  ]);
}

// 2. Introduction and significance
{
  const slide = contentSlide("Introduction & significance", 2);
  addText(slide, "problem-label", "HOW BOOKINGS ARRIVED", 72, 166, 320, 28, {
    fontSize: 18,
    bold: true,
    color: C.orange,
  });
  addBullet(slide, "problem-channel-1", "Facebook messages", 78, 218, 310, 40, 23);
  addBullet(slide, "problem-channel-2", "Phone calls", 78, 284, 310, 40, 23);
  addBullet(slide, "problem-channel-3", "Walk-in inquiries", 78, 350, 310, 40, 23);

  addText(slide, "problem-arrow", "→", 404, 268, 64, 72, {
    fontSize: 58,
    bold: true,
    color: C.orange,
    alignment: "center",
    verticalAlignment: "middle",
  });
  addText(slide, "challenge-label", "THE OPERATING CHALLENGE", 500, 166, 560, 28, {
    fontSize: 18,
    bold: true,
    color: C.orange,
  });
  addText(slide, "challenge-headline", "No single shared schedule", 500, 206, 650, 48, {
    fontSize: 32,
    bold: true,
    color: C.white,
  });
  addBullet(slide, "challenge-1", "Availability took extra coordination to confirm", 500, 270, 640, 40, 21);
  addBullet(slide, "challenge-2", "Booking details could be split across staff channels", 500, 324, 640, 46, 21);
  addBullet(slide, "challenge-3", "Manual records increased the risk of overlap or lost details", 500, 383, 660, 52, 21);

  addRect(slide, "significance-rule", 72, 476, 1136, 2, C.border);
  addText(slide, "significance-label", "WHY IT MATTERS", 72, 502, 240, 27, {
    fontSize: 18,
    bold: true,
    color: C.orange,
  });
  addText(
    slide,
    "significance-statement",
    "IñigoSync brings court availability, bookings and payment records into one system—giving customers online access while staff manage online and walk-in reservations together.",
    72,
    538,
    1136,
    102,
    { fontSize: 25, color: C.white },
  );
  addNote(slide, [
    "Explain that customers contacted the center through messages, calls, or walk-ins, while staff coordinated records manually.",
    "Emphasize the practical value: customers can check and reserve online; staff can see online and walk-in activity in the same system.",
    "Source: capstone Chapter 1, Project Context and Purpose.",
  ]);
}

// 3. Objectives
{
  const slide = contentSlide("Objectives", 3, C.band);
  addText(slide, "general-label", "GENERAL OBJECTIVE", 72, 160, 360, 30, {
    fontSize: 19,
    bold: true,
    color: C.orange,
  });
  addText(
    slide,
    "general-objective",
    "Develop a web-based booking management system that centralizes reservations, court schedules and payment records for Iñigos Sports Center.",
    72,
    199,
    1110,
    86,
    { fontSize: 28, bold: true, color: C.white },
  );
  addText(slide, "specific-label", "SPECIFIC OBJECTIVES", 72, 314, 360, 28, {
    fontSize: 19,
    bold: true,
    color: C.orange,
  });

  const objectives = [
    { x: 72, y: 360, n: "01", title: "Online booking", body: "Check availability and reserve a preferred court, date and time." },
    { x: 654, y: 360, n: "02", title: "Centralized management", body: "Manage online and walk-in bookings, schedules and staff records." },
    { x: 72, y: 502, n: "03", title: "Payment automation", body: "Connect successful payments with booking confirmation and receipts." },
    { x: 654, y: 502, n: "04", title: "Account security", body: "Protect accounts with email verification, role access and session controls." },
  ];
  objectives.forEach((o, i) => {
    addText(slide, `objective-${i + 1}-number`, o.n, o.x, o.y, 58, 52, {
      fontSize: 42,
      bold: true,
      color: C.orange,
    });
    addText(slide, `objective-${i + 1}-title`, o.title, o.x + 72, o.y + 2, 455, 34, {
      fontSize: 26,
      bold: true,
      color: C.white,
    });
    addText(slide, `objective-${i + 1}-body`, o.body, o.x + 72, o.y + 44, 465, 68, {
      fontSize: 21,
      color: C.muted,
    });
  });
  addNote(slide, [
    "State the general objective in one sentence, then summarize the four specific objectives.",
    "Source: capstone Chapter 1, Objectives.",
  ]);
}

// 4. Scope
{
  const slide = contentSlide("Scope", 4);
  addText(slide, "scope-subtitle", "Three user roles share one reservation workflow.", 72, 148, 900, 34, {
    fontSize: 22,
    color: C.muted,
  });
  addRect(slide, "scope-divider-1", 452, 211, 2, 394, C.border);
  addRect(slide, "scope-divider-2", 830, 211, 2, 394, C.border);
  const columns = [
    {
      x: 72,
      w: 350,
      title: "CUSTOMERS",
      items: ["Court details, rates and availability", "Online reservation and booking status", "Payment summary and receipt", "FAQs and announcements"],
    },
    {
      x: 490,
      w: 310,
      title: "STAFF",
      items: ["Online and walk-in bookings", "Court schedules and arrivals", "Payment and transaction records", "Receipts and daily reports"],
    },
    {
      x: 868,
      w: 340,
      title: "ADMINISTRATOR",
      items: ["Staff accounts and access", "Court listings and operating hours", "Grace-period and booking settings", "Activity monitoring and reports"],
    },
  ];
  columns.forEach((col, ci) => {
    addText(slide, `scope-role-${ci}`, col.title, col.x, 211, col.w, 36, {
      fontSize: 21,
      bold: true,
      color: C.orange,
    });
    col.items.forEach((item, j) => {
      addBullet(slide, `scope-${ci}-${j}`, item, col.x, 270 + j * 78, col.w, 61, 20);
    });
  });
  addNote(slide, [
    "Describe the role-based coverage briefly: customer booking, staff transaction handling, and administrator configuration and monitoring.",
    "Source: capstone Chapter 1, Scope.",
  ]);
}

// 5. Limitations
{
  const slide = contentSlide("Limitations", 5, C.band);
  const limits = [
    { n: "01", title: "Internet dependent", body: "Customers and staff need a working connection to book, confirm payments and update schedules." },
    { n: "02", title: "Single location", body: "The current configuration is built for Iñigos Sports Center and its operating needs." },
    { n: "03", title: "Sandbox payment testing", body: "PayMongo transactions were simulated in test mode; the results do not establish live-payment performance." },
  ];
  limits.forEach((lim, i) => {
    const y = 184 + i * 148;
    addText(slide, `limit-${i + 1}-number`, lim.n, 72, y, 64, 60, {
      fontSize: 44,
      bold: true,
      color: C.orange,
    });
    addText(slide, `limit-${i + 1}-title`, lim.title, 162, y + 2, 360, 40, {
      fontSize: 28,
      bold: true,
      color: C.white,
    });
    addText(slide, `limit-${i + 1}-body`, lim.body, 520, y + 2, 650, 77, {
      fontSize: 22,
      color: C.muted,
    });
    if (i < limits.length - 1) addRect(slide, `limit-rule-${i}`, 162, y + 103, 1008, 1, C.border);
  });
  addNote(slide, [
    "Be direct about the operating and evaluation boundaries. PayMongo results are from sandbox transactions only.",
    "Source: capstone Chapter 1, Limitations; Chapter 4, implementation and testing results.",
  ]);
}

// 6. Technology
{
  const slide = contentSlide("Technology used", 6);
  const layers = [
    { x: 72, title: "CLIENT", main: "HTML · CSS\nJavaScript", sub: "Responsive web interface" },
    { x: 468, title: "BACKEND & DATA", main: "Supabase\nPostgreSQL", sub: "Backend services and relational data" },
    { x: 864, title: "DEPLOYMENT", main: "Hostinger", sub: "Web hosting" },
  ];
  layers.forEach((layer, i) => {
    addText(slide, `tech-layer-${i}-label`, layer.title, layer.x, 216, 310, 30, {
      fontSize: 18,
      bold: true,
      color: C.orange,
    });
    addText(slide, `tech-layer-${i}-main`, layer.main, layer.x, 262, 310, 92, {
      fontSize: 34,
      bold: true,
      color: C.white,
    });
    addText(slide, `tech-layer-${i}-sub`, layer.sub, layer.x, 371, 310, 60, {
      fontSize: 21,
      color: C.muted,
    });
  });
  addText(slide, "tech-arrow-1", "→", 385, 285, 60, 58, {
    fontSize: 46,
    bold: true,
    color: C.orange,
    alignment: "center",
  });
  addText(slide, "tech-arrow-2", "→", 781, 285, 60, 58, {
    fontSize: 46,
    bold: true,
    color: C.orange,
    alignment: "center",
  });
  addRect(slide, "tech-payment-rule", 72, 486, 1136, 2, C.border);
  addText(slide, "tech-payment-label", "PAYMENT TESTING", 72, 516, 250, 28, {
    fontSize: 18,
    bold: true,
    color: C.orange,
  });
  addText(slide, "tech-payment", "PayMongo test account  ·  sandbox transactions", 72, 555, 930, 42, {
    fontSize: 27,
    bold: true,
    color: C.white,
  });
  addNote(slide, [
    "Walk through the stack from browser interface to backend services and database, then hosting.",
    "Clarify that PayMongo was tested in sandbox mode.",
    "Source: capstone Chapter 3, Technical Background; Chapter 4, Results and Discussion.",
  ]);
}

// 7. Methodology
{
  const slide = contentSlide("Methodology", 7, C.band);
  addText(slide, "method-subtitle", "Agile / Scrum · 10–15 day sprints described in the project plan", 72, 149, 1100, 34, {
    fontSize: 22,
    color: C.muted,
  });
  const stages = [
    { title: "Gather needs", body: "Interview and consult with the client." },
    { title: "Design", body: "Create Figma wireframes and data plans." },
    { title: "Build", body: "Develop features incrementally by sprint." },
    { title: "Evaluate", body: "Test with developers, adviser, client and users." },
    { title: "Improve", body: "Fix issues, retest and prepare deployment." },
  ];
  const starts = [72, 304, 536, 768, 1000];
  addRect(slide, "method-flow-line", 116, 272, 1040, 2, C.border);
  stages.forEach((stage, i) => {
    const x = starts[i];
    addRect(slide, `method-node-${i}`, x + 9, 248, 50, 50, C.orange, "none", 0, "ellipse");
    addText(slide, `method-number-${i}`, String(i + 1).padStart(2, "0"), x + 9, 253, 50, 36, {
      fontSize: 18,
      bold: true,
      color: C.black,
      alignment: "center",
      verticalAlignment: "middle",
    });
    addText(slide, `method-stage-${i}`, stage.title, x, 335, 200, 37, {
      fontSize: 25,
      bold: true,
      color: C.white,
    });
    addText(slide, `method-desc-${i}`, stage.body, x, 382, 198, 104, {
      fontSize: 20,
      color: C.muted,
    });
  });
  addText(slide, "method-feedback", "Client and adviser feedback informed the next iteration.", 72, 557, 1100, 38, {
    fontSize: 24,
    color: C.orangeLight,
  });
  addNote(slide, [
    "Explain that the team followed an iterative Agile approach: requirements, design, incremental development, review, and refinement.",
    "The project plan describes sprint cycles of about 10–15 days.",
    "Source: capstone Chapter 3, Methodology.",
  ]);
}

// 8. System prototype and recommended demo sequence
{
  const slide = contentSlide("System prototype", 8);
  addText(slide, "prototype-subtitle", "Customer-facing landing page and court discovery", 72, 148, 720, 32, {
    fontSize: 22,
    color: C.muted,
  });
  slide.images.add({
    blob: siteShotBytes,
    contentType: "image/png",
    alt: "IñigoSync customer landing page showing the dark theme, navigation and featured sports content",
    fit: "cover",
    position: { left: 72, top: 198, width: 700, height: 438 },
    geometry: "roundRect",
    borderRadius: "rounded-xl",
  });
  addRect(slide, "prototype-image-accent", 72, 645, 700, 4, C.orange);
  addText(slide, "demo-label", "SUGGESTED LIVE DEMO", 820, 204, 350, 30, {
    fontSize: 18,
    bold: true,
    color: C.orange,
  });
  const demo = [
    "Customer: choose a court, date and time; review the booking.",
    "Staff: record a walk-in and check the shared schedule.",
    "Admin: show court settings and booking activity.",
  ];
  demo.forEach((item, i) => {
    const y = 260 + i * 118;
    addText(slide, `demo-number-${i}`, String(i + 1).padStart(2, "0"), 820, y, 50, 38, {
      fontSize: 28,
      bold: true,
      color: C.orange,
    });
    addText(slide, `demo-step-${i}`, item, 878, y, 320, 88, {
      fontSize: 21,
      color: C.white,
    });
  });
  addNote(slide, [
    "Use the customer-facing landing page as the visual starting point. Keep the demonstration focused and short.",
    "Recommended live demo order: customer selects a court and schedule; staff records a walk-in and checks the same schedule; administrator reviews court settings and booking activity.",
    "Source: screenshot from the IñigoSync project; workflow scope from capstone Chapter 1.",
  ]);
}

// 9. Results and discussion
{
  const slide = contentSlide("Results & discussion", 9, C.band);
  addText(slide, "result-stat", "24 / 24", 72, 198, 410, 116, {
    fontSize: 88,
    bold: true,
    color: C.orange,
  });
  addText(slide, "result-stat-label", "documented functional test cases marked pass", 72, 318, 420, 64, {
    fontSize: 24,
    bold: true,
    color: C.white,
  });
  addText(slide, "result-range", "TC-01 to TC-24", 72, 391, 360, 32, {
    fontSize: 20,
    color: C.soft,
  });
  addRect(slide, "result-divider", 520, 185, 2, 370, C.border);
  addText(slide, "result-evidence-label", "WHAT THE EVIDENCE SHOWS", 566, 190, 610, 28, {
    fontSize: 18,
    bold: true,
    color: C.orange,
  });
  addBullet(slide, "result-evidence-1", "Customer, staff and administrator workflows were included, from account access through bookings, payment records, receipts and reports.", 566, 238, 610, 82, 21);
  addBullet(slide, "result-evidence-2", "Testing surfaced navigation, layout, schedule and data issues; revisions and adviser retesting followed.", 566, 337, 610, 76, 21);
  addBullet(slide, "result-evidence-3", "The final client evaluation reported approval of the revised system.", 566, 431, 610, 54, 21);
  addRect(slide, "discussion-rule", 72, 526, 1136, 2, C.orange);
  addText(slide, "discussion-label", "DISCUSSION", 72, 550, 190, 26, {
    fontSize: 18,
    bold: true,
    color: C.orange,
  });
  addText(slide, "discussion-statement", "The reported tests support the intended booking workflow; sandbox results do not establish production payment performance.", 72, 585, 1136, 62, {
    fontSize: 23,
    color: C.white,
  });
  addNote(slide, [
    "Report the exact evidence: Table 12 lists 24 functional cases, TC-01 through TC-24, all marked pass.",
    "Explain that earlier testing identified usability, layout, schedule, and data issues, followed by fixes and adviser retesting.",
    "Important source caveat: the testing section says the team was awaiting the client’s go-signal for deployment, while the implementation section later says launch occurred. Confirm the current deployment status before the defense; this deck does not claim a production launch.",
    "Source: capstone Chapter 4, Testing, Table 12, and Implementation Results.",
  ]);
}

// 10. Q&A / hand-off
{
  const slide = presentation.slides.add({ background: { fill: C.bg } });
  addRect(slide, "qa-accent", 0, 0, 14, 720, C.orange);
  slide.images.add({
    blob: logoBytes,
    contentType: "image/png",
    alt: "IñigoSync wordmark",
    fit: "contain",
    position: { left: 78, top: 72, width: 350, height: 148 },
  });
  addRect(slide, "qa-rule", 80, 302, 6, 190, C.orange);
  addText(slide, "qa-title", "Questions?", 118, 316, 900, 112, {
    fontSize: 82,
    bold: true,
    color: C.white,
  });
  addText(slide, "qa-demo-flow", "Demo hand-off: customer booking  →  staff walk-in  →  admin overview", 118, 454, 1030, 60, {
    fontSize: 23,
    color: C.muted,
  });
  addText(slide, "qa-footer", "Iñigos Sports Center  ·  STI College Lucena", 118, 638, 720, 28, {
    fontSize: 18,
    color: C.orangeLight,
  });
  addNote(slide, [
    "Invite questions from the panel.",
    "If a live demonstration is part of the defense, use the sequence shown: customer booking → staff walk-in entry → administrator overview.",
  ]);
}

await fs.mkdir(renderDir, { recursive: true });
await fs.mkdir(path.dirname(candidatePath), { recursive: true });
for (const [index, slide] of presentation.slides.items.entries()) {
  const png = await presentation.export({ slide, format: "png", scale: 1 });
  const pngPath = path.join(renderDir, `slide-${String(index + 1).padStart(2, "0")}.png`);
  await fs.writeFile(pngPath, new Uint8Array(await png.arrayBuffer()));
}
const pptx = await PresentationFile.exportPptx(presentation);
await pptx.save(candidatePath);
console.log(JSON.stringify({ slideCount: presentation.slides.items.length, candidatePath, renderDir }));
