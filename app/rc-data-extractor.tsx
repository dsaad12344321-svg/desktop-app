"use client";

import { useMemo, useState } from "react";
import { useFileLibrary } from "./file-library-provider";

type FolderEntry = { path: string; relativePath: string; name: string; size: number };
type ArrivalGuest = { room: string; name: string; phone: string; email: string; source: string };
type ExtractedRow = { file: string; room: string; name: string; phone: string; email: string; arrivalName: string; arrivalRoom: string; status: "matched" | "review" | "unmatched"; reason: string };

function clean(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim().toLowerCase();
}
function roomTokens(value: string) {
  return (value.match(/(?<!\d)\d{3,4}(?!\d)/g) || []).map((v) => v.padStart(4, "0"));
}
function nameBigrams(value: string) {
  const words = clean(value).split(" ").filter((v) => v.length >= 2);
  return new Set(words.flatMap((word) => Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2))));
}
function nameOverlap(a: string, b: string) {
  const aa = nameBigrams(a), bb = nameBigrams(b);
  let count = 0;
  aa.forEach((part) => { if (bb.has(part)) count++; });
  return count;
}
async function ocrImage(canvas: HTMLCanvasElement): Promise<string> {
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng", 1, {
    workerPath: "https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/worker.min.js",
    corePath: "https://cdn.jsdelivr.net/npm/tesseract.js-core@6.1.2",
    langPath: "https://tessdata.projectnaptha.com/4.0.0",
    logger: () => undefined,
  });
  try {
    const result = await worker.recognize(canvas);
    return result.data.text || "";
  } finally {
    await worker.terminate();
  }
}

async function pdfText(data: Uint8Array) {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  const pdf = await pdfjs.getDocument({ data }).promise;
  const pages: string[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const items = content.items.filter((item): item is typeof item & { str: string; transform: number[] } => "str" in item && "transform" in item && Boolean(item.str?.trim()));
    const rows: { y: number; cells: { x: number; text: string }[] }[] = [];
    for (const item of items) {
      const y = item.transform[5];
      let row = rows.find((candidate) => Math.abs(candidate.y - y) <= 4);
      if (!row) { row = { y, cells: [] }; rows.push(row); }
      row.cells.push({ x: item.transform[4], text: item.str.trim() });
    }
    let pageText = rows.sort((a,b) => b.y-a.y).map((row) => row.cells.sort((a,b) => a.x-b.x).map((cell) => cell.text).join(" ")).join("\n");
    if (pageText.trim().length < 35) {
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d");
      if (context) {
        await page.render({ canvasContext: context, viewport }).promise;
        pageText = await ocrImage(canvas);
      }
    }
    pages.push(pageText);
  }
  return pages.join("\n");
}
function extractContact(text: string, kind: "phone" | "email") {
  if (kind === "email") return text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || "";
  return text.match(/(?:\+?\d[\d\s().-]{7,}\d)/)?.[0]?.replace(/\s+/g, " ").trim() || "";
}
function extractCardName(text: string) {
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const labels = /^(?:guest\s*name|name\s*of\s*guest|full\s*name|client\s*name|surname\s*\/\s*name|name)\s*[:.-]?\s*/i;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(labels);
    if (match && lines[i].slice(match[0].length).trim().length >= 3) return lines[i].slice(match[0].length).trim();
    if (match && lines[i + 1]) return lines[i + 1];
  }
  const honorific = lines.find((line) => /\b(?:MR|MRS|MS|MISS|MSTR|DR)\.?\s+[A-Z][A-Z -]{3,}/i.test(line));
  if (honorific) return honorific.replace(/^.*?\b(?:MR|MRS|MS|MISS|MSTR|DR)\.?\s+/i, "").trim();
  return "";
}
function extractCardRoom(text: string) {
  const match = text.match(/(?:room\s*(?:no\.?|number)?|rm\s*no\.?)\s*[:#.-]?\s*(\d{3,4})/i);
  return match?.[1] || "";
}
function parseArrivalXml(text: string): ArrivalGuest[] {
  const doc = new DOMParser().parseFromString(text, "text/xml");
  if (doc.querySelector("parsererror")) throw new Error("تعذر قراءة ملف XML الخاص بالوصول.");
  const nodes = Array.from(doc.getElementsByTagName("*")).filter((node) => node.tagName.split(":").pop() === "G_RESERVATION");
  return nodes.map((node) => {
    const get = (names: string[]) => {
      for (const name of names) {
        const el = Array.from(node.getElementsByTagName("*")).find((item) => item.tagName.split(":").pop()?.toUpperCase() === name);
        if (el?.textContent?.trim()) return el.textContent.trim();
      }
      return "";
    };
    return { room: get(["ROOM_NO", "DISP_ROOM_NO"]), name: get(["GUEST_NAME", "NAME", "PRIMARY_GUEST_NAME"]), phone: get(["PHONE", "PHONE_NO", "MOBILE"]), email: get(["EMAIL", "EMAIL_ADDRESS"]), source: "arr.xml" };
  }).filter((guest) => guest.room || guest.name);
}
function parseArrivalPdf(text: string): ArrivalGuest[] {
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const guests: ArrivalGuest[] = [];
  for (const line of lines) {
    const match = line.match(/^(\d{3,4})\s+(.{3,})$/);
    if (!match || !/[A-Za-z]{2}/.test(match[2])) continue;
    const rest = match[2].replace(/\s+\d{5,10}.*$/, "").trim();
    const name = rest.split(/\s{2,}|\s+(?:MR|MRS|MS)\.?\s+/i).filter(Boolean).pop() || rest;
    if (name.length >= 3) guests.push({ room: match[1], name, phone: extractContact(line, "phone"), email: extractContact(line, "email"), source: "arr.pdf" });
  }
  return guests;
}

export default function RCDataExtractor() {
  const { reservations, registrations, setFolderPath: saveSharedFolder, readBytes } = useFileLibrary();
  const folderPath = reservations.path;
  const entries = reservations.entries as FolderEntry[];
  const rcFolderPath = registrations.path;
  const rcEntries = registrations.entries as FolderEntry[];
  const [arrivalFile, setArrivalFile] = useState<File | null>(null);
  const [rows, setRows] = useState<ExtractedRow[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [roomSearchInput, setRoomSearchInput] = useState("");
  const [searchedRoom, setSearchedRoom] = useState("");

  const pdfEntries = useMemo(() => rcEntries.filter((entry) => entry.name.toLowerCase().endsWith(".pdf") && !/^arr\.pdf$/i.test(entry.name)), [rcEntries]);

  async function chooseRCFolder() {
    if (!window.desktopBridge) {
      setMessage("اختيار المجلد متاح من تطبيق سطح المكتب فقط.");
      return;
    }
    try {
      const selectedPath = await window.desktopBridge.selectFolder();
      if (!selectedPath) return;
      const files = await saveSharedFolder("registration", selectedPath);

      setRows([]);
      setMessage(`تم حفظ المجلد. عثرت الأداة على ${files.filter((entry) => entry.name.toLowerCase().endsWith(".pdf")).length} ملف PDF داخله ومجلداته الفرعية.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "تعذر اختيار مجلد النماذج.");
    }
  }
  const matchedCount = rows.filter((row) => row.status === "matched").length;
  const reviewCount = rows.filter((row) => row.status === "review").length;

  async function runExtraction() {
    setBusy(true); setMessage("جارٍ قراءة تقرير الوصول ونماذج التسجيل..."); setRows([]);
    try {
      let arrivalGuests: ArrivalGuest[] = [];
      const linkedArrivals = [
        ...entries.filter((entry) => /^(arr\.pdf|arr\.xml)$/i.test(entry.name)).map((entry) => ({ entry, root: folderPath })),
        ...rcEntries.filter((entry) => /^(arr\.pdf|arr\.xml)$/i.test(entry.name)).map((entry) => ({ entry, root: rcFolderPath }))
      ].filter((item) => item.root);
      const sourceFile = arrivalFile;
      if (sourceFile) {
        const text = sourceFile.name.toLowerCase().endsWith(".xml") ? await sourceFile.text() : await pdfText(new Uint8Array(await sourceFile.arrayBuffer()));
        arrivalGuests = sourceFile.name.toLowerCase().endsWith(".xml") ? parseArrivalXml(text) : parseArrivalPdf(text);
      } else if (linkedArrivals.length && window.desktopBridge) {
        const arrival = linkedArrivals.find((item) => item.entry.name.toLowerCase() === "arr.xml") || linkedArrivals.find((item) => item.entry.name.toLowerCase() === "arr.pdf");
        if (arrival) {
          const bytes = await readBytes(arrival.root === folderPath ? "reservations" : "registration", arrival.entry as FolderEntry);
          const text = arrival.entry.name.toLowerCase().endsWith(".xml") ? new TextDecoder().decode(bytes) : await pdfText(new Uint8Array(bytes));
          arrivalGuests = arrival.entry.name.toLowerCase().endsWith(".xml") ? parseArrivalXml(text) : parseArrivalPdf(text);
        }
      }
      if (!arrivalGuests.length) throw new Error("لم أجد سجلات وصول قابلة للقراءة. تأكد من وجود arr.pdf أو arr.xml داخل المجلد المرتبط أو اختر التقرير يدويًا.");
      const selected: Array<{ name: string; data: Uint8Array }> = [];
      if (window.desktopBridge && rcFolderPath) {
        for (const entry of pdfEntries) {
          const bytes = await readBytes("registration", entry);
          selected.push({ name: entry.relativePath || entry.name, data: new Uint8Array(bytes) });
        }
      }
      if (!selected.length) throw new Error("لم يتم العثور على ملفات PDF داخل مجلد النماذج المحفوظ. اختر مجلدًا يحتوي على نماذج التسجيل.");
      const output: ExtractedRow[] = [];
      for (const file of selected) {
        if (/^arr\.pdf$/i.test(file.name)) continue;
        const text = await pdfText(file.data);
        const name = extractCardName(text);
        const room = extractCardRoom(text);
        const filenameRooms = roomTokens(file.name);
        const roomCandidates = arrivalGuests.filter((guest) => {
          const arrivalRoom = String(guest.room || "").replace(/\\D/g, "").padStart(4, "0");
          const cardRoom = String(room || "").replace(/\\D/g, "").padStart(4, "0");
          return (cardRoom && arrivalRoom && (cardRoom === arrivalRoom || cardRoom.includes(arrivalRoom.slice(-2)) || arrivalRoom.includes(cardRoom.slice(-2)))) ||
            filenameRooms.some((token) => token === arrivalRoom || token.includes(arrivalRoom.slice(-2)) || arrivalRoom.includes(token.slice(-2)));
        });
        const nameCandidates = arrivalGuests.map((guest) => ({ guest, score: name ? nameOverlap(name, guest.name) : 0 }))
          .filter((item) => item.score >= 1).sort((a,b) => b.score-a.score);
        const bestName = nameCandidates[0];
        const uniqueName = Boolean(bestName && (!nameCandidates[1] || bestName.score > nameCandidates[1].score));
        const roomGuest = roomCandidates.length === 1 ? roomCandidates[0] : null;
        const sameGuest = Boolean(roomGuest && uniqueName && bestName && roomGuest === bestName.guest);
        const candidate = sameGuest ? roomGuest : roomGuest || (uniqueName ? bestName?.guest : null);
        const hasRoomEvidence = Boolean(roomGuest);
        const hasNameEvidence = Boolean(uniqueName && bestName);
        let status: ExtractedRow["status"] = "unmatched";
        let reason = "لم يتم العثور على تطابق موثوق في تقرير الوصول.";
        if (sameGuest) { status = "matched"; reason = "تطابق الغرفة والاسم مع سجل النزيل نفسه في تقرير الوصول."; }
        else if (candidate || roomCandidates.length || nameCandidates.length) { status = "review"; reason = "يوجد تطابق جزئي أو أن الغرفة والاسم يشيران إلى سجلين مختلفين؛ يرجى المراجعة يدويًا."; }
        const phone = extractContact(text, "phone");
        const email = extractContact(text, "email");
        output.push({ file: file.name, room: room || filenameRooms[0] || "", name, phone, email, arrivalName: candidate?.name || bestName?.guest.name || "", arrivalRoom: candidate?.room || roomCandidates[0]?.room || "", status, reason });
      }
      setRows(output);
      setMessage(`اكتمل الفحص: ${output.length} نموذج، ${output.filter((row) => row.status === "matched").length} مطابق، ${output.filter((row) => row.status === "review").length} يحتاج مراجعة.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "حدث خطأ أثناء استخراج بيانات النماذج.");
    } finally { setBusy(false); }
  }

  function downloadCsv() {
    const headers = ["PDF","Room","Guest name","Phone","Email","Arrival name","Arrival room","Status","Review"];
    const quote = (value: string) => '"' + String(value || "").replace(/"/g, '""') + '"';
    const csv = "\uFEFF" + [headers, ...rows.map((row) => [row.file,row.room,row.name,row.phone,row.email,row.arrivalName,row.arrivalRoom,row.status,row.reason])].map((line) => line.map(quote).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = "rc-data-extractor.csv"; link.click(); URL.revokeObjectURL(url);
  }

  const statusFilteredRows = showAll ? rows : rows.filter((row) => row.status !== "matched");
  const normalizedSearchRoom = searchedRoom.replace(/\\D/g, "");
  const visibleRows = normalizedSearchRoom
    ? statusFilteredRows.filter((row) => [row.room, row.arrivalRoom].some((room) => String(room || "").replace(/\\D/g, "") === normalizedSearchRoom))
    : statusFilteredRows;
  return <section className="panel">
    <h3>RC Data extractor</h3>
    <p className="muted">تقرأ الأداة نماذج التسجيل PDF من مجلد الحجوزات المرتبط، وتستخدم arr.pdf أو arr.xml لمراجعة أرقام الغرف وأسماء النزلاء. التطابق الجزئي لا يُعتمد تلقائيًا عند وجود أكثر من احتمال.</p>
    {folderPath ? <p className="saved-hint" dir="ltr">مجلد الحجوزات: {folderPath}</p> : <p className="saved-hint">لا يوجد مجلد حجوزات مرتبط؛ يمكنك اختيار تقرير الوصول يدويًا.</p>}
    <div className="upload">
      <label>مجلد نماذج PDF الإضافية</label>
      <button className="button" type="button" onClick={chooseRCFolder}>اختيار مجلد النماذج</button>
      {rcFolderPath ? <div className="filename" dir="ltr">{rcFolderPath}<br />تم العثور على {pdfEntries.length} ملف PDF (بما في ذلك المجلدات الفرعية)</div> : <div className="filename">لم يتم اختيار مجلد بعد. سيتم تذكر آخر مجلد تختاره وفتحه تلقائيًا عند دخول الأداة.</div>}
    </div>
    <div className="upload">
      <label htmlFor="rc-data-arrival">تقرير الوصول (اختياري إذا كان arr.pdf أو arr.xml موجودًا في المجلد)</label>
      <input id="rc-data-arrival" type="file" accept=".pdf,.xml,application/pdf,text/xml,application/xml" onChange={(event) => setArrivalFile(event.target.files?.[0] || null)} />
      {arrivalFile && <div className="filename">{arrivalFile.name}</div>}
    </div>
    <button className="button" type="button" onClick={runExtraction} disabled={busy}>{busy ? "جارٍ الاستخراج..." : "استخراج بيانات النماذج"}</button>
    {message && <div className="notice" role="status">{message}</div>}
    {rows.length > 0 && <>
      <div className="summary-grid">
        <div><strong>{rows.length}</strong><span>النماذج</span></div>
        <div><strong>{matchedCount}</strong><span>مطابق</span></div>
        <div><strong>{reviewCount}</strong><span>مراجعة</span></div>
        <div><strong>{rows.filter((row) => row.status === "unmatched").length}</strong><span>غير مطابق</span></div>
      </div>
      <div className="uploads">
        <input
          type="text"
          inputMode="numeric"
          value={roomSearchInput}
          onChange={(event) => setRoomSearchInput(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") setSearchedRoom(roomSearchInput.trim()); }}
          placeholder="اكتب رقم الغرفة للبحث"
          aria-label="رقم الغرفة للبحث"
        />
        <button type="button" className="add-button" onClick={() => setSearchedRoom(roomSearchInput.trim())}>بحث عن الغرفة</button>
        {searchedRoom && <button type="button" className="add-button" onClick={() => { setRoomSearchInput(""); setSearchedRoom(""); }}>إلغاء البحث</button>}
        <button type="button" className="add-button" onClick={() => setShowAll((value) => !value)}>{showAll ? "عرض الحالات التي تحتاج مراجعة فقط" : "عرض جميع النماذج"}</button>
        <button type="button" className="add-button" onClick={downloadCsv}>تنزيل Excel CSV</button>
      </div>
      {searchedRoom && <p className="muted">نتائج البحث عن الغرفة {searchedRoom}: {visibleRows.length} نتيجة</p>}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 850 }}>
          <thead><tr>{["ملف PDF","الغرفة","اسم النموذج","الهاتف","البريد","اسم الوصول المطابق","غرفة الوصول","الحالة"].map((heading) => <th key={heading} style={{ textAlign: "right", padding: 8, borderBottom: "1px solid #cbd5e1" }}>{heading}</th>)}</tr></thead>
          <tbody>{visibleRows.map((row, index) => <tr key={row.file + index}>
            <td style={{ padding: 8, borderBottom: "1px solid #e2e8f0" }}>{row.file}</td><td>{row.room || "—"}</td><td>{row.name || "غير واضح"}</td><td>{row.phone || "—"}</td><td>{row.email || "—"}</td><td>{row.arrivalName || "—"}</td><td>{row.arrivalRoom || "—"}</td><td title={row.reason}>{row.status === "matched" ? "مطابق" : row.status === "review" ? "مراجعة" : "غير مطابق"}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </>}
  </section>;
}
