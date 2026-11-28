"use client";

import { useMemo, useState } from "react";
import { useFileLibrary } from "./file-library-provider";

type FolderEntry = { path: string; relativePath: string; name: string; size: number; mtimeMs: number; rootPath?: string };
type ArrivalGuest = { room: string; name: string; phone: string; email: string; source: string };
type FieldResult = { value: string; status: "likely" | "review" | "missing"; confidence: number };
type RegistrationGuest = { familyName: FieldResult; firstName: FieldResult; birthDate: FieldResult; passport: FieldResult; nationality: FieldResult };
type RegistrationPage = { page: number; arrivalDate: FieldResult; departureDate: FieldResult; persons: FieldResult; room: FieldResult; guests: RegistrationGuest[]; email: FieldResult; telephone: FieldResult; address: FieldResult; profession: FieldResult };
type ExtractedRow = { file: string; room: string; pages: RegistrationPage[]; arrivalName: string; arrivalRoom: string; status: "matched" | "review" | "unmatched"; reason: string };

function clean(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim().toLowerCase();
}
function roomTokens(value: string) {
  return (value.match(/(?<!\d)\d{3,4}(?!\d)/g) || []).map((v) => v.padStart(4, "0"));
}
function requestedRoomTokens(value: string) {
  return value.split(/[,،;\s]+/).map((part) => part.replace(/\D/g, "")).filter((part) => part.length === 3 || part.length === 4).map((part) => part.padStart(4, "0"));
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
type OcrWorker = { recognize: (image: HTMLCanvasElement) => Promise<{ data: { text?: string; confidence?: number } }>; terminate: () => Promise<void> };
type CropRect = { x: number; y: number; width: number; height: number };
async function readCrop(worker: OcrWorker, source: HTMLCanvasElement, rect: CropRect): Promise<FieldResult> {
  const sx=source.width/1024, sy=source.height/1444;
  const x=Math.max(0,Math.round(rect.x*sx)), y=Math.max(0,Math.round(rect.y*sy));
  const width=Math.min(source.width-x,Math.round(rect.width*sx)), height=Math.min(source.height-y,Math.round(rect.height*sy));
  const crop=document.createElement("canvas"); crop.width=Math.max(1,width*2); crop.height=Math.max(1,height*2);
  const ctx=crop.getContext("2d");
  if(ctx){ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality="high";ctx.drawImage(source,x,y,width,height,0,0,crop.width,crop.height);}
  const result=await worker.recognize(crop);
  const value=(result.data.text||"").replace(/[|_~]/g," ").replace(/\s+/g," ").trim();
  const confidence=Math.max(0,Math.min(100,Number(result.data.confidence||0)));
  return {value,confidence,status:value?(confidence>=62?"likely":"review"):"missing"};
}
async function extractRegistrationPages(data: Uint8Array): Promise<RegistrationPage[]> {
  const pdfjs=await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc=new URL("pdfjs-dist/build/pdf.worker.min.mjs",import.meta.url).toString();
  const pdf=await pdfjs.getDocument({data}).promise;
  const {createWorker}=await import("tesseract.js");
  const worker=await createWorker("eng",1,{
    workerPath:"https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/worker.min.js",
    corePath:"https://cdn.jsdelivr.net/npm/tesseract.js-core@6.1.2",
    langPath:"https://tessdata.projectnaptha.com/4.0.0",logger:()=>undefined
  }) as unknown as OcrWorker;
  const pages:RegistrationPage[]=[];
  try{
    for(let pageNo=1;pageNo<=pdf.numPages;pageNo++){
      const page=await pdf.getPage(pageNo), viewport=page.getViewport({scale:2.5});
      const canvas=document.createElement("canvas");canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
      const context=canvas.getContext("2d");if(!context)continue;
      await page.render({canvasContext:context,viewport}).promise;
      const field=(rect:CropRect)=>readCrop(worker,canvas,rect);
      const [arrivalDate,departureDate,persons,room]=await Promise.all([
        field({x:52,y:230,width:175,height:34}),field({x:230,y:230,width:164,height:34}),
        field({x:397,y:230,width:153,height:34}),field({x:553,y:230,width:260,height:34})
      ]);
      const guests:RegistrationGuest[]=[];
      for(const y of [284,329,374,419,464]){
        const [familyName,firstName,birthDate,passport,nationality]=await Promise.all([
          field({x:82,y,width:146,height:38}),field({x:232,y,width:161,height:38}),
          field({x:398,y,width:151,height:38}),field({x:554,y,width:258,height:38}),
          field({x:817,y,width:155,height:38})
        ]);
        if([familyName,firstName,birthDate,passport,nationality].some(v=>v.value.length>1))
          guests.push({familyName,firstName,birthDate,passport,nationality});
      }
      const [email,telephone,address,profession]=await Promise.all([
        field({x:52,y:550,width:341,height:31}),field({x:398,y:550,width:151,height:31}),
        field({x:554,y:550,width:258,height:31}),field({x:817,y:550,width:155,height:31})
      ]);
      pages.push({page:pageNo,arrivalDate,departureDate,persons,room,guests,email,telephone,address,profession});
    }
  }finally{await worker.terminate();}
  return pages;
}
function fieldStatusLabel(field:FieldResult){
  return field.status==="likely"?"قراءة مرجحة":field.status==="review"?"يحتاج مراجعة":"غير مدون أو غير واضح";
}
function fieldValue(field:FieldResult){
  return field.value||(field.status==="missing"?"غير مدون أو غير واضح":"غير واضح بما يكفي للاعتماد");
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

  async function runExtraction(searchQuery = searchedRoom) {
    const requestedRooms = requestedRoomTokens(searchQuery);
    const isRoomSearch = requestedRooms.length > 0;
    const filesToProcess = isRoomSearch
      ? pdfEntries.filter((entry) => roomTokens(entry.name).some((room) => requestedRooms.includes(room)))
      : searchQuery.trim()
        ? pdfEntries.filter((entry) => clean(entry.name).includes(clean(searchQuery)))
        : pdfEntries;
    setBusy(true);
    setMessage(isRoomSearch ? `جارٍ البحث عن الغرف: ${requestedRooms.join("، ")}...` : searchQuery.trim() ? "جارٍ البحث في أسماء ملفات PDF..." : "جارٍ قراءة تقرير الوصول ونماذج التسجيل...");
    setRows([]);
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
        for (const entry of filesToProcess) {
          const bytes = await readBytes("registration", entry);
          selected.push({ name: entry.relativePath || entry.name, data: new Uint8Array(bytes) });
        }
      }
      if (!selected.length) {
        if (searchQuery.trim()) throw new Error(isRoomSearch
          ? `لم أجد ملف PDF يحتوي اسمه على أرقام الغرف المطلوبة: ${requestedRooms.join("، ")}. تأكد من كتابة الأرقام مفصولة بفاصلة.`
          : "لم أجد ملف PDF يطابق الاسم الذي أدخلته.");
        throw new Error("لم يتم العثور على ملفات PDF داخل مجلد النماذج المحفوظ. اختر مجلدًا يحتوي على نماذج التسجيل.");
      }
      const output: ExtractedRow[] = [];
      for (const file of selected) {
        if (/^arr\.pdf$/i.test(file.name)) continue;
        const pages = await extractRegistrationPages(file.data);
        const filenameRooms = roomTokens(file.name);
        const cardRoom = pages.map(page => page.room.value.replace(/\D/g,"")).find(Boolean) || "";
        const room = cardRoom || filenameRooms[0] || "";
        const normalizedCardRoom = room.replace(/\D/g,"").padStart(4,"0");
        const roomCandidates = arrivalGuests.filter(guest => {
          const arrivalRoom=String(guest.room||"").replace(/\D/g,"").padStart(4,"0");
          return Boolean(normalizedCardRoom && arrivalRoom && normalizedCardRoom===arrivalRoom);
        });
        const guestNames=pages.flatMap(page=>page.guests.map(guest=>[guest.firstName.value,guest.familyName.value].filter(Boolean).join(" "))).filter(Boolean);
        const nameCandidates=arrivalGuests.map(guest=>({guest,score:Math.max(0,...guestNames.map(name=>nameOverlap(name,guest.name)))}))
          .filter(item=>item.score>=2).sort((a,b)=>b.score-a.score);
        const bestName=nameCandidates[0], uniqueName=Boolean(bestName&&(!nameCandidates[1]||bestName.score>nameCandidates[1].score));
        const roomGuest=roomCandidates.length===1?roomCandidates[0]:null;
        const sameGuest=Boolean(roomGuest&&uniqueName&&bestName&&roomGuest===bestName.guest);
        const candidate=sameGuest?roomGuest:roomGuest||(uniqueName?bestName?.guest:null);
        let status:ExtractedRow["status"]="unmatched",reason="لم يتم العثور على تطابق موثوق في تقرير الوصول.";
        if(sameGuest){status="matched";reason="تطابق رقم الغرفة والاسم مع سجل النزيل نفسه في تقرير الوصول.";}
        else if(candidate||roomCandidates.length||nameCandidates.length){status="review";reason="يوجد تطابق جزئي أو أكثر من احتمال؛ يرجى المراجعة يدويًا.";}
        output.push({file:file.name,room:room||filenameRooms[0]||"",pages,arrivalName:candidate?.name||bestName?.guest.name||"",arrivalRoom:candidate?.room||roomCandidates[0]?.room||"",status,reason});
      }
      setRows(output);
      setMessage(`اكتمل البحث والفحص: ${output.length} ملف PDF للغرف المحددة، ${output.filter((row) => row.status === "matched").length} مطابق، ${output.filter((row) => row.status === "review").length} يحتاج مراجعة.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "حدث خطأ أثناء استخراج بيانات النماذج.");
    } finally { setBusy(false); }
  }

  function downloadCsv() {
    const headers=["PDF","Page","Room","Arrival date","Departure date","Persons","Family name","First name","Birth date","Passport","Nationality","Email","Telephone","Address","Profession","Arrival match","Arrival room","Status","Review"];
    const records:string[][]=[];
    rows.forEach(row=>row.pages.forEach(page=>{
      const guests=page.guests.length?page.guests:[null];
      guests.forEach(guest=>records.push([row.file,String(page.page),page.room.value,page.arrivalDate.value,page.departureDate.value,page.persons.value,
        guest?.familyName.value||"",guest?.firstName.value||"",guest?.birthDate.value||"",guest?.passport.value||"",guest?.nationality.value||"",
        page.email.value,page.telephone.value,page.address.value,page.profession.value,row.arrivalName,row.arrivalRoom,row.status,row.reason]));
    }));
    const quote=(value:string)=>'"'+String(value||"").replace(/"/g,'""')+'"';
    const csv="\uFEFF"+[headers,...records].map(line=>line.map(quote).join(",")).join("\r\n");
    const url=URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"}));
    const link=document.createElement("a");link.href=url;link.download="rc-registration-details.csv";link.click();URL.revokeObjectURL(url);
  }

  const statusFilteredRows = showAll ? rows : rows.filter((row) => row.status !== "matched");
  const visibleRows = statusFilteredRows;
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
    <button className="button" type="button" onClick={() => runExtraction("")} disabled={busy}>{busy ? "جارٍ الاستخراج..." : "استخراج بيانات النماذج"}</button>
    {message && <div className="notice" role="status">{message}</div>}
    <div className="uploads">
      <input
        type="text"
        value={roomSearchInput}
        onChange={(event) => setRoomSearchInput(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && !busy) { const query = roomSearchInput.trim(); setSearchedRoom(query); runExtraction(query); } }}
        placeholder="أرقام الغرف مثل 1116,0380 أو اسم ملف PDF"
        aria-label="البحث برقم الغرفة أو اسم النزيل"
      />
      <button type="button" className="add-button" onClick={() => { const query = roomSearchInput.trim(); setSearchedRoom(query); runExtraction(query); }} disabled={busy}>بحث الغرف المحددة</button>
      {searchedRoom && <button type="button" className="add-button" onClick={() => { setRoomSearchInput(""); setSearchedRoom(""); }}>إلغاء البحث</button>}
    </div>
    {rows.length > 0 && <>
      <div className="summary-grid">
        <div><strong>{rows.length}</strong><span>النماذج</span></div>
        <div><strong>{matchedCount}</strong><span>مطابق</span></div>
        <div><strong>{reviewCount}</strong><span>مراجعة</span></div>
        <div><strong>{rows.filter((row) => row.status === "unmatched").length}</strong><span>غير مطابق</span></div>
      </div>
      <div className="uploads">
        <button type="button" className="add-button" onClick={() => setShowAll((value) => !value)}>{showAll ? "عرض الحالات التي تحتاج مراجعة فقط" : "عرض جميع النماذج"}</button>
        <button type="button" className="add-button" onClick={downloadCsv}>تنزيل Excel CSV</button>
      </div>
      {searchedRoom && <p className="muted">نتائج البحث عن "{searchedRoom}": {visibleRows.length} نتيجة</p>}
      <div className="rc-registration-results">
        {visibleRows.map((row,index)=>(
          <article key={row.file+index} className="panel" style={{marginTop:18,border:"1px solid #cbd5e1"}}>
            <div style={{display:"flex",justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
              <div><h3>ملف النموذج: {row.file}</h3><p className="muted">الغرفة: {row.room||"غير محددة"} — {row.status==="matched"?"مطابق":row.status==="review"?"يحتاج مراجعة":"غير مطابق"}</p></div>
              <span className="saved-hint">{row.reason}</span>
            </div>
            {row.pages.map(page=>(
              <section key={page.page} style={{marginTop:16}}>
                <h4>بيانات الإقامة والتواصل — الصفحة {page.page}</h4>
                <div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse",minWidth:560}}>
                  <thead><tr><th style={{textAlign:"right",padding:8}}>الحقل</th><th style={{textAlign:"right",padding:8}}>البيانات المستخرجة</th><th style={{textAlign:"right",padding:8}}>التقييم</th></tr></thead>
                  <tbody>{([["رقم الغرفة",page.room],["الوصول",page.arrivalDate],["المغادرة",page.departureDate],["عدد الأشخاص",page.persons],["الهاتف",page.telephone],["البريد الإلكتروني",page.email],["العنوان",page.address],["المهنة",page.profession]] as Array<[string,FieldResult]>).map(([label,item])=><tr key={label}><td style={{padding:8,borderBottom:"1px solid #e2e8f0"}}>{label}</td><td style={{padding:8,borderBottom:"1px solid #e2e8f0"}}>{fieldValue(item)}</td><td style={{padding:8,borderBottom:"1px solid #e2e8f0"}}>{fieldStatusLabel(item)}{item.value?" ("+Math.round(item.confidence)+"%)":""}</td></tr>)}</tbody>
                </table></div>
                <h4 style={{marginTop:18}}>بيانات النزيل ({page.guests.length})</h4>
                {!page.guests.length?<p className="muted">لم يتم التعرف على بيانات نزلاء في هذه الصفحة.</p>:page.guests.map((guest,guestIndex)=>(
                  <div key={guestIndex} style={{marginTop:12,padding:12,border:"1px solid #e2e8f0",borderRadius:10}}>
                    <strong>النزيل {guestIndex+1}</strong>
                    <div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse",minWidth:560}}>
                      <thead><tr><th style={{textAlign:"right",padding:8}}>الحقل</th><th style={{textAlign:"right",padding:8}}>البيانات المستخرجة</th><th style={{textAlign:"right",padding:8}}>التقييم</th></tr></thead>
                      <tbody>{([["اسم العائلة",guest.familyName],["الاسم الأول",guest.firstName],["تاريخ الميلاد",guest.birthDate],["رقم الجواز",guest.passport],["الجنسية",guest.nationality]] as Array<[string,FieldResult]>).map(([label,item])=><tr key={label}><td style={{padding:8,borderBottom:"1px solid #e2e8f0"}}>{label}</td><td style={{padding:8,borderBottom:"1px solid #e2e8f0"}}>{fieldValue(item)}</td><td style={{padding:8,borderBottom:"1px solid #e2e8f0"}}>{fieldStatusLabel(item)}{item.value?" ("+Math.round(item.confidence)+"%)":""}</td></tr>)}</tbody>
                    </table></div>
                  </div>
                ))}
              </section>
            ))}
            <p className="saved-hint" style={{marginTop:12}}>اسم الوصول المطابق: {row.arrivalName||"—"} | غرفة الوصول: {row.arrivalRoom||"—"}</p>
          </article>
        ))}
      </div>
    </>}
  </section>;
}
