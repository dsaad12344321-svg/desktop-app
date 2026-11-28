"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useFileLibrary, type SharedFolderEntry } from "./file-library-provider";

function normalizeRoom(value: string) {
  const digits = value.replace(/\\D/g, "");
  return digits.length === 3 || digits.length === 4 ? digits.padStart(4, "0") : "";
}

function parseRoomQuery(query: string): string[] {
  const rooms = new Set<string>();
  const parts = query.split(/[,،;\\s]+/).map((part) => part.trim()).filter(Boolean);
  for (const part of parts) {
    const range = part.match(/^(\\d{3,4})\\s*[-–—]\\s*(\\d{3,4})$/);
    if (range) {
      const start = Number(normalizeRoom(range[1]));
      const end = Number(normalizeRoom(range[2]));
      if (end < start) throw new Error("نهاية نطاق الغرف يجب أن تكون أكبر من بدايته.");
      if (end - start > 999) throw new Error("النطاق كبير جدًا. اختر نطاقًا لا يتجاوز 1000 غرفة.");
      for (let room = start; room <= end; room++) rooms.add(String(room).padStart(4, "0"));
      continue;
    }
    const room = normalizeRoom(part);
    if (!room) throw new Error("اكتب أرقام الغرف من 3 أو 4 أرقام، واستخدم فاصلة أو نطاقًا مثل 1077-1085.");
    rooms.add(room);
  }
  return [...rooms];
}

function roomsInFilename(name: string) {
  return (name.match(/(?<!\\d)\\d{3,4}(?!\\d)/g) || []).map((room) => room.padStart(4, "0"));
}

export default function RCPreview() {
  const { registrations, setFolderPath, readBytes } = useFileLibrary();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SharedFolderEntry[]>([]);
  const [selected, setSelected] = useState<SharedFolderEntry | null>(null);
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const pdfEntries = useMemo(
    () => registrations.entries.filter((entry) => entry.name.toLowerCase().endsWith(".pdf")),
    [registrations.entries],
  );

  async function chooseFolder() {
    if (!window.desktopBridge) {
      setMessage("ربط مجلد الملفات متاح من تطبيق سطح المكتب فقط.");
      return;
    }
    try {
      const path = await window.desktopBridge.selectFolder();
      if (!path) return;
      await setFolderPath("registration", path);
      setResults([]);
      setSelected(null);
      setMessage("تم ربط مجلد نماذج التسجيل وتحديث فهرس الملفات.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "تعذر ربط المجلد.");
    }
  }

  function searchRooms() {
    try {
      const requested = parseRoomQuery(query);
      if (!requested.length) {
        setMessage("أدخل رقم غرفة أو نطاقًا مثل 1077-1085.");
        return;
      }
      const wanted = new Set(requested);
      const matches = pdfEntries.filter((entry) => roomsInFilename(entry.relativePath || entry.name).some((room) => wanted.has(room)));
      setResults(matches);
      setSelected(null);
      setPdfData(null);
      setPageCount(0);
      setMessage(matches.length
        ? "تم العثور على " + matches.length + " ملف PDF للغرف: " + requested.join("، ")
        : "لم يتم العثور على ملفات PDF لأرقام الغرف المحددة. تأكد من أسماء الملفات أو حدّث فهرس المجلد.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "تعذر تنفيذ البحث.");
    }
  }

  async function openPreview(entry: SharedFolderEntry) {
    setBusy(true);
    setMessage("جارٍ تحميل الملف...");
    setSelected(entry);
    setPdfData(null);
    setPageNumber(1);
    setPageCount(0);
    try {
      const bytes = await readBytes("registration", entry);
      setPdfData(bytes);
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
      const pdf = await pdfjs.getDocument({ data: bytes.slice() }).promise;
      setPageCount(pdf.numPages);
      setMessage("تم فتح الملف. اختر الصفحة التي تريد معاينتها أو طباعتها.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "تعذر فتح ملف PDF.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function renderPage() {
      if (!pdfData || !selected || !canvasRef.current) return;
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
        const pdf = await pdfjs.getDocument({ data: pdfData.slice() }).promise;
        const page = await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1.65 });
        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;
        const context = canvas.getContext("2d");
        if (!context) return;
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({ canvasContext: context, viewport }).promise;
      } catch (error) {
        if (!cancelled) setMessage(error instanceof Error ? error.message : "تعذر عرض الصفحة.");
      }
    }
    void renderPage();
    return () => { cancelled = true; };
  }, [pdfData, selected, pageNumber]);

  function printCurrentPage() {
    const canvas = canvasRef.current;
    if (!canvas || !selected) {
      setMessage("افتح ملفًا واختر صفحة قبل الطباعة.");
      return;
    }
    const image = canvas.toDataURL("image/png");
    const printFrame = document.createElement("iframe");
    printFrame.style.position = "fixed";
    printFrame.style.width = "0";
    printFrame.style.height = "0";
    printFrame.style.border = "0";
    printFrame.style.right = "0";
    printFrame.style.bottom = "0";
    document.body.appendChild(printFrame);
    const printDocument = printFrame.contentDocument;
    const printWindow = printFrame.contentWindow;
    if (!printDocument || !printWindow) {
      printFrame.remove();
      setMessage("تعذرت تهيئة صفحة الطباعة.");
      return;
    }
    printDocument.open();
    printDocument.write(`<!doctype html><html><head><title>${selected.name} - Page ${pageNumber}</title><style>@page{margin:8mm}html,body{margin:0;padding:0;text-align:center}img{display:block;max-width:100%;max-height:calc(100vh - 16mm);margin:auto;object-fit:contain}@media print{img{width:100%;height:auto}}</style></head><body><img src="${image}" /></body></html>`);
    printDocument.close();
    printWindow.onload = () => {
      printWindow.focus();
      printWindow.print();
      window.setTimeout(() => printFrame.remove(), 1000);
    };
  }

  return (
    <section className="panel">
      <h2>RC Preview</h2>
      <p className="muted">ابحث عن بطاقة تسجيل باستخدام رقم غرفة أو عدة غرف أو نطاق متتالٍ، ثم افتح الملف لمعاينة صفحاته واطبع الصفحة المطلوبة. لا تحتاج الأداة إلى arr.pdf أو arr.xml أو أي تقرير وصول.</p>
      <div className="upload">
        <label>مجلد نماذج التسجيل PDF</label>
        <button type="button" className="add-button" onClick={chooseFolder}>اختيار / تغيير مجلد النماذج</button>
        <p className="saved-hint">{registrations.path ? registrations.path : "لم يتم ربط مجلد نماذج التسجيل بعد."}</p>
        <p className="saved-hint">{registrations.loading ? "جارٍ فهرسة الملفات..." : "ملفات PDF في الفهرس: " + pdfEntries.length}</p>
        <button type="button" className="add-button" disabled={registrations.loading || !registrations.path} onClick={() => void (async () => { try { await (await import("./file-library-provider")); window.location.reload(); } catch { setMessage("تعذر تحديث الفهرس."); } })()}>تحديث الفهرس</button>
      </div>
      <div className="uploads" style={{ marginTop: 16 }}>
        <label style={{ display: "grid", gap: 8, fontWeight: 700 }}>
          أرقام الغرف
          <input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") searchRooms(); }} placeholder="1077 أو 1077,1080 أو 1077-1085" />
        </label>
        <button type="button" className="button" style={{ marginTop: 0 }} onClick={searchRooms} disabled={registrations.loading || !pdfEntries.length}>بحث ومعاينة الملفات</button>
      </div>
      {message && <div className="notice" role="status">{message}</div>}
      {results.length > 0 && (
        <div className="towel-results">
          <h3>الملفات المطابقة ({results.length})</h3>
          <div className="folder-results">
            {results.map((entry) => (
              <div className="folder-result" key={entry.path}>
                <div className="folder-result-top">
                  <div><strong dir="ltr">{entry.relativePath || entry.name}</strong><p className="muted">الغرف في اسم الملف: {roomsInFilename(entry.relativePath || entry.name).join("، ")}</p></div>
                  <button type="button" className="add-button" disabled={busy} onClick={() => void openPreview(entry)}>{selected?.path === entry.path ? "الملف المحدد" : "فتح المعاينة"}</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {selected && pdfData && (
        <div className="towel-results">
          <div className="section-heading">
            <div><h3 dir="ltr">{selected.name}</h3><p className="muted">عدد الصفحات: {pageCount}</p></div>
            <button type="button" className="add-button" onClick={printCurrentPage}>طباعة الصفحة {pageNumber}</button>
          </div>
          <div className="uploads" style={{ margin: "14px 0", alignItems: "center" }}>
            <button type="button" className="add-button" disabled={pageNumber <= 1} onClick={() => setPageNumber((value) => Math.max(1, value - 1))}>الصفحة السابقة</button>
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>صفحة
              <input type="number" min={1} max={pageCount} value={pageNumber} onChange={(event) => setPageNumber(Math.min(pageCount || 1, Math.max(1, Number(event.target.value) || 1)))} style={{ width: 90 }} />
              من {pageCount}
            </label>
            <button type="button" className="add-button" disabled={pageNumber >= pageCount} onClick={() => setPageNumber((value) => Math.min(pageCount, value + 1))}>الصفحة التالية</button>
          </div>
          <div style={{ background: "#e9eef4", padding: 12, overflow: "auto", textAlign: "center", borderRadius: 10 }}>
            <canvas ref={canvasRef} style={{ maxWidth: "100%", height: "auto", background: "white", boxShadow: "0 2px 12px #0002" }} />
          </div>
        </div>
      )}
    </section>
  );
}
