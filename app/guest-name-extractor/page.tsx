"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import voucherRules from "./voucher-extraction-rules.json";

type IndexedFile = {
  id: string; name: string; path: string; company: string; extension: string;
  day?: string; month?: string;
  size: number; content: string; pages: string[]; visualPages?: string[]; file: File;
};
type SearchResult = IndexedFile & { matchedPages: number[] };
type MsgAttachmentPreview = { name: string; type: string; blob: Blob; url: string; size: number };
type AttachmentSearchMatch = { page: number; excerpt: string };
type MsgPreviewData = { subject: string; sender: string; senderEmail: string; to: string; cc: string; sent: string; bodyHtml: string; bodyText: string; attachments: MsgAttachmentPreview[] };

type ArrivalRecord = { roomNo: string; name: string; confirmationNo: string; arrivalTime: string };

const ARRIVAL_REPORT_KEY = "nationality-arrival-report-v1";

async function extractArrivalReport(file: File): Promise<ArrivalRecord[]> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const records: ArrivalRecord[] = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const items: { y: number; x: number; text: string }[] = [];

    for (const item of content.items) {
      if (!("str" in item) || !item.str.trim() || !("transform" in item)) continue;
      items.push({
        y: item.transform[5],
        x: item.transform[4],
        text: item.str.trim(),
      });
    }

    // PMS reports may position cells on slightly different baselines.
    // A wider tolerance keeps Room No. + Name + Company on the same row.
    const grouped: { y: number; items: { x: number; text: string }[] }[] = [];
    for (const item of items) {
      let line = grouped.find((entry) => Math.abs(entry.y - item.y) <= 5);
      if (!line) {
        line = { y: item.y, items: [] };
        grouped.push(line);
      }
      line.items.push({ x: item.x, text: item.text });
    }

    const lines = grouped
      .sort((a, b) => b.y - a.y)
      .map((line) =>
        line.items
          .sort((a, b) => a.x - b.x)
          .map((item) => item.text)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim(),
      );

    const isRoomLine = (line: string) => {
      const match = line.match(/^(\d{3,5})\s+(.+)$/);
      return Boolean(match && match[2].includes(",") && !/^\d{5,9}\b/.test(match[2]));
    };

    for (let index = 0; index < lines.length; index++) {
      const roomLine = lines[index].match(/^(\d{3,5})\s+(.+)$/);
      if (!roomLine || !roomLine[2].includes(",")) continue;

      const rowText = roomLine[2];
      const companyMarker = rowText.search(/\s+T\s*-/i);
      let guestName = companyMarker >= 0 ? rowText.slice(0, companyMarker).trim() : "";
      if (!guestName) {
        const titledName = rowText.match(/^(.+?,\s*(?:Mr|Mrs|Ms|Miss|Mstr|Master)\.?)\b/i);
        if (titledName) guestName = titledName[1].trim();
      }
      if (!guestName) continue;

      let confirmationNo = "";
      let arrivalTime = "";

      // Conf No. and Arr. Time are printed on the following visual row.
      // Search a few lines ahead because PDF text extraction can split cells.
      for (let next = index + 1; next < Math.min(index + 5, lines.length); next++) {
        if (isRoomLine(lines[next])) break;

        if (!confirmationNo) {
          const conf = lines[next].match(/^\s*(\d{5,9})(?=\s|$)/);
          if (conf) confirmationNo = conf[1];
        }
        if (!arrivalTime) {
          const time = lines[next].match(/\b([01]?\d|2[0-3]):[0-5]\d\b/);
          if (time) arrivalTime = time[0].padStart(5, "0");
        }
        if (confirmationNo && arrivalTime) break;
      }

      if (confirmationNo && arrivalTime) {
        records.push({
          roomNo: roomLine[1], // Keep leading zeroes, e.g. 0321.
          name: guestName.replace(/\s+/g, " "),
          confirmationNo,
          arrivalTime,
        });
      }
    }
  }

  const unique = new Map<string, ArrivalRecord>();
  for (const record of records) unique.set(record.confirmationNo, record);
  return Array.from(unique.values());
}

const NATIVE_FOLDER_KEY = "long-beach-native-reservation-folder-v1";
const GUEST_STATE_KEY = "nationality-guest-extractor-state-v1";
const SUPPORTED = new Set(["pdf", "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "docx", "msg", "txt", "csv", "xml", "html", "htm", "eml", "log"]);
const normalize = (value: string) =>
  value.toLocaleLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function getPreviewMimeType(extension: string) {
  const mimeTypes: Record<string, string> = {
    pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", webp: "image/webp", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff",
  };
  return mimeTypes[extension.toLowerCase()] || "application/octet-stream";
}

type VoucherRule = { id: string; company: string; aliases: string[]; parser: string; signatures: string[]; bookingIdentifiers: string[]; guestFields: string[] };
const configuredVoucherRules = voucherRules as { version: number; rules: VoucherRule[]; searchFields: string[] };

function detectVoucherCompany(text: string, currentCompany = "") {
  if (/noreply@w2m\.com|world\s*2\s*meet|world2meet/i.test(text)
    || (/\bBooking\s+Code\b/i.test(text)
      && /\bPassenger\s+Name\b/i.test(text)
      && /\bPassenger\s+Last\s+Name\b/i.test(text))) return "W2M";
  if (currentCompany.trim() && currentCompany.trim() !== "غير محددة") return currentCompany.trim();
  // FUN&SUN is a separate supplier format and must not be reclassified.
  if (/FUN\s*&\s*SUN|FUN\s+SUN|EX\s+TUI\s+RUSSIA/i.test(text)) {
    return currentCompany || "غير محددة";
  }
  // SUN can be identified from its own branding or its distinctive passenger
  // table, even when the PDF omits the company heading.
  if (/\bSUN\s+INTERNATIONAL\b|\bSUNBUG\b/i.test(text)
    || (/\bHOTEL\s+C\/IN\s+LIST\b/i.test(text)
      && /\bVoucher\b/i.test(text)
      && /\bSurname,\s*Name\b/i.test(text)
      && /\bAge\/B\.Date\b/i.test(text))
    || (/passenger\s+informations/i.test(text)
      && /surname\s*,?\s*name/i.test(text)
      && /\bbirthdate\b/i.test(text)
      && /\btitle\b/i.test(text)
      && /\bage\b/i.test(text))) return "SUN International";
  for (const rule of configuredVoucherRules.rules) {
    if (rule.signatures.length && rule.signatures.every((pattern) => {
      try { return new RegExp(pattern, "i").test(text); } catch { return false; }
    })) return rule.company;
  }
  return currentCompany || "غير محددة";
}

function matchesSearchText(searchableText: string, query: string) {
  const haystack = normalize(searchableText);
  const needle = normalize(query);
  if (!needle) return false;
  const compactNeedle = needle.replace(/\s+/g, "");
  if (/^\d+$/.test(compactNeedle)) return haystack.replace(/\s+/g, "").includes(compactNeedle);
  const tokens = needle.split(/\s+/).filter(Boolean);
  return tokens.length > 1 ? tokens.every((token) => haystack.includes(token)) : haystack.includes(needle);
}


// Arrival reports may use "SURNAME, Mr. GIVEN" while vouchers use
// "MR. SURNAME GIVEN". Match meaningful name parts regardless of order.
const arrivalNameMatchesText = (arrivalName: string, searchableText: string) => {
  const ignored = new Set(["mr", "mrs", "ms", "miss", "mstr", "master"]);
  const tokens = normalize(arrivalName).split(/\s+/).filter((token) => token.length > 1 && !ignored.has(token));
  const searchable = ` ${normalize(searchableText)} `;
  return tokens.length >= 2 && tokens.every((token) => searchable.includes(` ${token} `));
};

const SUN_IGNORED_TITLE_TOKENS = new Set([
  "mr", "mrs", "ms", "miss", "mstr", "master", "chd", "child", "inf", "adt", "adult",
]);

function getSunSearchTokens(value: string) {
  return normalize(value).split(/\s+/).filter((token) => token && !SUN_IGNORED_TITLE_TOKENS.has(token));
}

const MONTH_FOLDER_PATTERN = /^\\d{1,2}[._ -]?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:[._ -].*)?$/i;

function getFolderMetadata(path: string): { company: string; day?: string; month?: string } {
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return { company: "غير محددة" };

  const root = parts[0];
  const isMonthFolder = MONTH_FOLDER_PATTERN.test(root);
  const isDayFolder = /^\\d{1,2}$/.test(root);
  const nestedDay = isMonthFolder && /^\\d{1,2}$/.test(parts[1] || "");

  // Daily upload: Day / Company / Booking file
  // Monthly upload: Month / Day / Company / Booking file
  const companyIndex = nestedDay ? 2 : 1;
  const company = parts.length > companyIndex + 1 ? parts[companyIndex] : "غير محددة";

  return {
    company,
    day: nestedDay ? parts[1] : isDayFolder ? root : undefined,
    month: isMonthFolder ? root : undefined,
  };
}

function getNativeFolderMetadata(relativePath: string): { company: string; day?: string; month?: string } {
  const parts = relativePath.split("/").filter(Boolean);
  const monthIndex = parts.findIndex((part) => MONTH_FOLDER_PATTERN.test(part));
  if (monthIndex >= 0) {
    const dayIndex = monthIndex + 1;
    return {
      month: parts[monthIndex],
      day: /^\\d{1,2}$/.test(parts[dayIndex] || "") ? parts[dayIndex] : undefined,
      company: parts[dayIndex + 1] || parts[dayIndex] || "غير محددة",
    };
  }
  if (/^\\d{1,2}$/.test(parts[0] || "")) {
    return { day: parts[0], company: parts[1] || "غير محددة" };
  }
  return { company: parts.length > 1 ? parts[0] : "غير محددة" };
}

async function extractText(file: File, extension: string): Promise<{ content: string; pages: string[]; visualPages?: string[] }> {
  // Images are indexed by filename and previewed directly; OCR is not attempted here.
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff"].includes(extension)) {
    return { content: "", pages: [""] };
  }
  if (["txt", "csv", "xml", "html", "htm", "eml", "log"].includes(extension)) {
    const content = await file.text();
    return { content, pages: [content] };
  }
  const buffer = await file.arrayBuffer();
  if (extension === "docx") {
    const mammoth = await import("mammoth/mammoth.browser");
    const result = await mammoth.extractRawText({ arrayBuffer: buffer });
    return { content: result.value || "", pages: [result.value || ""] };
  }
  if (extension === "msg") {
    const { MsgReader } = await import("@kenjiuno/msgreader-web-ng");
    const message = new MsgReader(buffer);
    const data = message.getFileData();
    const recipientNames = (data.recipients || [])
      .map((recipient) => recipient.name)
      .filter((name): name is string => typeof name === "string" && Boolean(name.trim()));
    const attachmentRows = Array.isArray(data.attachments) ? data.attachments as unknown as Array<Record<string, unknown>> : [];
    const attachmentNames = attachmentRows.map((attachment) => String(attachment.fileName || attachment.name || "").trim()).filter(Boolean);
    const htmlBodyValue = (data as unknown as { bodyHtml?: string | Uint8Array; html?: string | Uint8Array }).bodyHtml
      || (data as unknown as { html?: string | Uint8Array }).html;
    const htmlBodyText = htmlBodyValue ? htmlToPlainText(htmlBodyValue) : "";
    let compressedRtfText = "";
    const compressedRtf = (data as unknown as { compressedRtf?: Uint8Array }).compressedRtf;
    if (compressedRtf && compressedRtf.byteLength) {
      try {
        const { decompressRTF } = await import("@kenjiuno/decompressrtf");
        const decompressed = decompressRTF(Array.from(compressedRtf));
        const decodedRtf = rtfToPlainText(new TextDecoder("windows-1252").decode(new Uint8Array(decompressed)));
        compressedRtfText = /<(?:html|body|table|tr|td)\b/i.test(decodedRtf)
          ? htmlToPlainText(decodedRtf)
          : decodedRtf;
      } catch {
        // Some messages contain a corrupt RTF stream; retain their plain/HTML body.
      }
    }
    const fields = [
      data.subject && `الموضوع: ${data.subject}`,
      data.senderName && `المرسل: ${data.senderName}`,
      data.senderEmail && `البريد الإلكتروني: ${data.senderEmail}`,
      data.clientSubmitTime && `تاريخ الإرسال: ${data.clientSubmitTime}`,
      recipientNames.length ? `المستلمون: ${recipientNames.join(", ")}` : "",
      attachmentNames.length ? `المرفقات: ${attachmentNames.join(", ")}` : "",
      typeof data.body === "string" ? data.body : "",
      htmlBodyText,
      compressedRtfText,
      typeof data.headers === "string" ? `\n--- بيانات الرسالة ---\n${data.headers}` : "",
    ].filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
    const content = Array.from(new Set(fields)).join("\n\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ").trim();
    if (!content || !/[\p{L}\p{N}]/u.test(content)) {
      throw new Error("تعذر استخراج نص مقروء من ملف Outlook MSG.");
    }
    // Index readable PDF attachments as additional searchable pages of the MSG.
    // This makes guest names inside Outlook booking vouchers searchable from
    // the main folder search, not only from the attachment preview.
    const msgReader = message as unknown as {
      getAttachment: (attachment: unknown) => { fileName?: string; content: Uint8Array };
    };
    const attachmentPages: string[] = [];
    for (const attachment of attachmentRows) {
      const attachmentName = String(attachment.fileName || attachment.name || "").trim();
      const attachmentExtension = attachmentName.split(".").pop()?.toLowerCase() || "";
      try {
        const extractedAttachment = msgReader.getAttachment(attachment);
        const attachmentBytes = new Uint8Array(extractedAttachment.content);

        if (attachmentExtension === "pdf") {
          const pdfjs = await import("pdfjs-dist");
          pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
          const pdf = await pdfjs.getDocument({ data: attachmentBytes }).promise;
          for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
            const page = await pdf.getPage(pageNumber);
            const pageContent = await page.getTextContent();
            // Keep PDF table cells in visual reading order (top-to-bottom,
            // then left-to-right). Some suppliers emit DOB cells before the
            // guest-name cells in the PDF's internal object order.
            const positionedItems = pageContent.items
              .filter((item): item is typeof item & { str: string; transform: number[] } =>
                "str" in item && "transform" in item && Boolean(item.str?.trim()))
              .map((item) => ({
                text: item.str.trim(),
                x: item.transform[4],
                y: item.transform[5],
              }));
            const visualRows: { y: number; cells: { x: number; text: string }[] }[] = [];
            for (const item of positionedItems) {
              let row = visualRows.find((candidate) => Math.abs(candidate.y - item.y) <= 2);
              if (!row) {
                row = { y: item.y, cells: [] };
                visualRows.push(row);
              }
              row.cells.push({ x: item.x, text: item.text });
            }
            attachmentPages.push(visualRows
              .sort((a, b) => b.y - a.y)
              .map((row) => row.cells.sort((a, b) => a.x - b.x).map((cell) => cell.text).join(" "))
              .join("\n"));
          }
        } else if (attachmentExtension === "docx") {
          const mammoth = await import("mammoth/mammoth.browser");
          const result = await mammoth.extractRawText({
            arrayBuffer: attachmentBytes.buffer.slice(
              attachmentBytes.byteOffset,
              attachmentBytes.byteOffset + attachmentBytes.byteLength,
            ) as ArrayBuffer,
          });
          if (result.value?.trim()) attachmentPages.push(result.value);
        } else if (["txt", "csv", "xml", "html", "htm", "eml", "log"].includes(attachmentExtension)) {
          const text = new TextDecoder().decode(attachmentBytes);
          if (text.trim()) attachmentPages.push(text);
        }
      } catch {
        // Keep the MSG searchable even if one attachment cannot be parsed.
      }
    }
    return { content: [content, ...attachmentPages].join("\n"), pages: [content, ...attachmentPages] };
  }
  if (extension === "pdf") {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
    const pages: string[] = [];
    const visualPages: string[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const text = await page.getTextContent();
      // Preserve the original flat page text for Single View.
      pages.push(text.items.map((item) => ("str" in item ? item.str : "")).join(" "));

      // Keep a second, visually ordered representation for Multiple View.
      // SUN HOTEL C/IN LIST rows depend on their original table layout.
      const positionedItems = text.items
        .filter((item): item is typeof item & { str: string; transform: number[] } =>
          "str" in item && "transform" in item && Boolean(item.str?.trim()))
        .map((item) => ({
          text: item.str.trim(),
          x: item.transform[4],
          y: item.transform[5],
        }));
      const visualRows: { y: number; cells: { x: number; text: string }[] }[] = [];
      for (const item of positionedItems) {
        let row = visualRows.find((candidate) => Math.abs(candidate.y - item.y) <= 2);
        if (!row) {
          row = { y: item.y, cells: [] };
          visualRows.push(row);
        }
        row.cells.push({ x: item.x, text: item.text });
      }
      visualPages.push(visualRows
        .sort((a, b) => b.y - a.y)
        .map((row) => row.cells.sort((a, b) => a.x - b.x).map((cell) => cell.text).join(" "))
        .join("\n"));
    }
    return { content: pages.join("\n"), pages, visualPages };
  }
  return { content: "", pages: [""] };
}

function titleCaseName(value: string) {
  return value.trim().toLocaleLowerCase().replace(/(^|[\s'-])([\p{L}])/gu,
    (_match, separator: string, letter: string) => separator + letter.toLocaleUpperCase());
}

function htmlToPlainText(value: string | Uint8Array | ArrayBuffer) {
  let html = "";
  if (typeof value === "string") html = value;
  else {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    try { html = new TextDecoder("utf-8").decode(bytes); }
    catch { html = new TextDecoder("windows-1252").decode(bytes); }
  }
  if (!html.trim()) return "";
  if (typeof DOMParser !== "undefined") {
    const document = new DOMParser().parseFromString(html, "text/html");
    document.querySelectorAll("script,style,head").forEach((node) => node.remove());
    document.querySelectorAll("br").forEach((node) => node.replaceWith("\n"));
    document.querySelectorAll("tr").forEach((node) => node.append("\n"));
    document.querySelectorAll("td,th").forEach((node) => node.append(" | "));
    return (document.body.textContent || "").replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  return html.replace(/<\/(?:tr|p|div|li|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ").trim();
}

function rtfToPlainText(value: string) {
  let text = value
    .replace(/\\'[0-9a-f]{2}/gi, (token) => {
      const byte = Number.parseInt(token.slice(2), 16);
      return new TextDecoder("windows-1252").decode(new Uint8Array([byte]));
    })
    .replace(/\\u(-?\d+)\??/g, (_match, raw) => String.fromCharCode((Number(raw) + 65536) % 65536))
    .replace(/\\(?:par|line)\b\s?/gi, "\n")
    .replace(/\\tab\b\s?/gi, "\t")
    .replace(/\\(?:cell|row)\b\s?/gi, " | ")
    .replace(/\\[a-zA-Z]+-?\d* ?/g, " ")
    .replace(/\\[^a-zA-Z]/g, " ")
    .replace(/[{}]/g, " ");
  return text.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function extractW2mPeople(text: string, searchTerm: string) {
  const clean = text.replace(/\r/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ");
  const passengersStart = clean.search(/\bPassengers?\s*:/i);
  const section = passengersStart >= 0 ? clean.slice(passengersStart) : clean;
  const sectionEnd = section.search(/\bNumber\s+of\s+Adults?\s*\/\s*Childs?\s*\/\s*Bab(?:y|ies)\b|\bBooking\s+Summary\b|\bPayment\s+Details\b/i);
  const passengerText = sectionEnd > 0 ? section.slice(0, sectionEnd) : section;
  const people: { name: string; dob: string }[] = [];
  const add = (name: string, detail = "") => {
    const normalizedName = name.replace(/\s+/g, " ").replace(/^[*•\-\s]+|[|,;\s]+$/g, "").trim();
    if (!normalizedName || normalizedName.split(/\s+/).length < 2) return;
    people.push({ name: titleCaseName(normalizedName), dob: detail.trim() });
  };

  // Standard W2M bullet format: "* Full Name (Age: 21)" or a DOB label.
  const bulletPattern = /(?:^|\n|\s)[*•]\s*([\p{L}\p{M}][\p{L}\p{M}'’.-]*(?:\s+[\p{L}\p{M}][\p{L}\p{M}'’.-]*){1,7})\s*(?:\(\s*(?:Age\s*:\s*(\d{1,3})|(?:DOB|Birth\s*date|Date\s*of\s*birth)\s*:\s*(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}))\s*\)|[-|]\s*(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})|\(\s*(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\s*\))?/giu;
  for (const match of passengerText.matchAll(bulletPattern)) {
    add(match[1], match[2] ? "(Age: " + match[2] + ")" : match[3] || match[4] || "");
  }
  // Some templates omit bullets; accept unbulleted rows only when they carry
  // an explicit age or birthdate so table headings cannot become guest names.
  const unbulletedPattern = /(?:^|\n)\s*([\p{L}\p{M}][\p{L}\p{M}'’.-]*(?:\s+[\p{L}\p{M}][\p{L}\p{M}'’.-]*){1,7})\s*(?:\(\s*(?:Age\s*:\s*(\d{1,3})|(?:DOB|Birth\s*date|Date\s*of\s*birth)\s*:\s*(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}))\s*\)|[-|]\s*(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})|\(\s*(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\s*\))/giu;
  if (!people.length) {
    for (const match of passengerText.matchAll(unbulletedPattern)) {
      add(match[1], match[2] ? "(Age: " + match[2] + ")" : match[3] || match[4] || "");
    }
  }

  // W2M can also send a passenger table with separate first/last-name columns.
  const lines = passengerText.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const headerIndex = people.length ? -1 : lines.findIndex((line) =>
    /Passenger\s+Name/i.test(line) && /Passenger\s+Last\s+Name/i.test(line),
  );
  if (headerIndex >= 0) {
    const header = lines[headerIndex].split(/\s*\|\s*|\t+|\s{2,}/).map(normalize);
    const firstIndex = header.findIndex((cell) => /passenger name|first name|given name/.test(cell));
    const lastIndex = header.findIndex((cell) => /passenger last name|last name|surname/.test(cell));
    const ageIndex = header.findIndex((cell) => /^age$/.test(cell));
    const dobIndex = header.findIndex((cell) => /birth|dob|date of birth/.test(cell));
    for (const line of lines.slice(headerIndex + 1)) {
      if (/^(number of adults|booking summary|payment details)/i.test(line)) break;
      const cells = line.split(/\s*\|\s*|\t+|\s{2,}/).map((cell) => cell.trim());
      if (firstIndex < 0 || lastIndex < 0 || !cells[firstIndex] || !cells[lastIndex]) continue;
      const dob = dobIndex >= 0 ? cells[dobIndex] || "" : "";
      const age = ageIndex >= 0 ? cells[ageIndex] || "" : "";
      add(cells[firstIndex] + " " + cells[lastIndex], dob.match(/\d{1,2}[./-]\d{1,2}[./-]\d{2,4}/)?.[0]
        || (age.match(/^\d{1,3}$/) ? "(Age: " + age + ")" : ""));
    }
  }

  if (!people.length) {
    // Label/value layout used by some W2M email templates.
    const rowPattern = /(?:Passenger\s+Name|First\s+Name)\s*:?\s*([\p{L}\p{M}'’.-]+)[\s|,]+(?:Passenger\s+Last\s+Name|Last\s+Name|Surname)\s*:?\s*([\p{L}\p{M}'’.-]+)(?:[\s|,]+(?:Age\s*:?\s*(\d{1,3})|(?:DOB|Birth\s*date|Date\s*of\s*birth)\s*:?\s*(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})))?/giu;
    for (const match of passengerText.matchAll(rowPattern)) add(match[1] + " " + match[2], match[3] ? "(Age: " + match[3] + ")" : match[4] || "");
  }

  if (!people.length) return [];
  const query = normalize(searchTerm);
  const queryCompact = query.replace(/\s+/g, "");
  const bookingMatches = Boolean(query && normalize(clean).replace(/\s+/g, "").includes(queryCompact));
  const nameMatches = !query || people.some((person) => {
    const parts = normalize(person.name).split(/\s+/);
    const tokens = query.split(/\s+/).filter(Boolean);
    return tokens.length > 0 && tokens.every((token) => parts.some((part) => part.includes(token)));
  });
  return !query || bookingMatches || nameMatches ? people : [];
}

function titleCaseAnexName(value: string) {
  // Anex prints guest names as SURNAME GIVEN-NAME; show them as Given-name Surname.
  const parts = value.trim().split(/\s+/).filter(Boolean);
  return titleCaseName(parts.length > 1 ? [...parts.slice(1), parts[0]].join(" ") : value);
}

function expandEagleDob(value: string) {
  const parts = value.trim().split(/[./-]/);
  if (parts.length !== 3) return value;
  const [day, month, rawYear] = parts;
  const year = rawYear.length === 4
    ? rawYear
    : String(Number(rawYear) <= 29 ? 2000 + Number(rawYear) : 1900 + Number(rawYear));
  return day.padStart(2, "0") + "." + month.padStart(2, "0") + "." + year;
}

function extractEaglePeople(text: string) {
  // Eagle Travel Outlook rooming lists use a Names/Age table. Outlook's
  // text extraction commonly places the guest-name column and DOB column
  // in separate runs, so collect both columns in order and pair by index.
  const header = /\bNames\b[\s\S]{0,100}\bAge\b[\s\S]{0,50}\bACC\b/i.exec(text);
  if (!header || header.index === undefined) return [];
  const start = header.index + header[0].indexOf("Names") + "Names".length;
  const tail = text.slice(start);
  // The actual Eagle table ends before the commercial breakdown. Some
  // emails say "Waiting for your reply with confirmation", not the shorter
  // phrase used in older samples, so prefer the table's own boundary.
  const endMatch = /\b(?:Breakdown|Waiting\s+for\s+your\s+(?:reply\s+with\s+)?confirmation|Best\s+regards|From)\b/i.exec(tail);
  const table = endMatch ? tail.slice(0, endMatch.index) : tail.slice(0, 18000);

  const namePattern = /\b(?:Mr|Mrs|Ms|Miss)\.?\s+([\p{L}][\p{L}'’.-]{0,45})\s*\/\s*([\p{L}][\p{L}'’.-]*)/giu;
  const names = Array.from(table.matchAll(namePattern), (match) =>
    titleCaseName(match[1].trim() + " " + match[2].trim()),
  );
  // Dates are emitted in the same guest order as the Names column, although
  // Outlook may place them after the names within each rooming-list row.
  const dates = Array.from(table.matchAll(/\b(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\b/g),
    (match) => expandEagleDob(match[1]));

  if (!names.length || names.length !== dates.length) return [];
  return names.map((name, index) => ({ name, dob: dates[index] }));
}

function extractTravelWaysPeople(text: string, searchTerm: string) {
  // Travel Ways EBD reports repeat the booking voucher only on the first
  // guest row. Attach subsequent titled DOB rows to that same booking.
  type BookingGroup = { voucher: string; people: { name: string; dob: string }[] };
  const groups: BookingGroup[] = [];
  let current: BookingGroup | null = null;

  const parseGuestRow = (line: string) => {
    const match = line.match(
      /^\s*(?:MR|MRS|MS|MISS|MSTR|MASTER|CHD|CHILD|INF)\.?\s+(.+?)\s+(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})(?=\s|$)/i,
    );
    if (!match) return null;
    const name = match[1].replace(/\s+/g, " ").trim();
    if (!name || /^(?:surname,? name|total pax|total room)$/i.test(name)) return null;
    return { name: titleCaseName(name), dob: match[2].replace(/[/-]/g, ".") };
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const bookingStart = line.match(/^([A-Z][A-Z0-9_-]{1,12})\s+([A-Z0-9-]{5,})\s+\d+\s+(.+)$/i);
    if (bookingStart) {
      if (current?.people.length) groups.push(current);
      current = { voucher: bookingStart[2], people: [] };
      const firstGuest = parseGuestRow(bookingStart[3]);
      if (firstGuest) current.people.push(firstGuest);
      continue;
    }

    if (!current) continue;
    const continuationGuest = parseGuestRow(line);
    if (continuationGuest) {
      current.people.push(continuationGuest);
      continue;
    }

    if (/^(?:\d{1,2}[./-]\d{1,2}[./-]\d{4}\s+Totals|Total\s+(?:Pax|Room)\s*:|NOTE:)/i.test(line)) {
      if (current.people.length) groups.push(current);
      current = null;
    }
  }
  if (current?.people.length) groups.push(current);

  const query = normalize(searchTerm);
  if (!query) return groups.flatMap((group) => group.people);
  const compactQuery = query.replace(/\s+/g, "");
  const nameTokens = query.split(/\s+/).filter(
    (token) => token.length > 1 && !/^(?:mr|mrs|ms|miss|mstr|master|chd|child|inf)$/i.test(token),
  );
  const matchingGroups = groups.filter((group) => {
    const voucher = normalize(group.voucher).replace(/\s+/g, "");
    if (compactQuery === voucher) return true;
    return group.people.some((person) => {
      const name = normalize(person.name);
      return name.includes(query) || (nameTokens.length > 0 && nameTokens.every((token) => name.includes(token)));
    });
  });
  return matchingGroups.flatMap((group) => group.people);
}

function extractPeople(text: string, searchTerm: string, company = "", enableSunCheckInList = false) {
  company = detectVoucherCompany(text, company);
  const isTravelWaysReport = /travel\s*ways/i.test(company)
    || (/HOTEL\s+CONTRACT\s+EBD\s+LIST/i.test(text)
      && /\bOperator\b[\s\S]{0,250}\bVoucher\b/i.test(text));
  if (isTravelWaysReport) {
    const travelWaysPeople = extractTravelWaysPeople(text, searchTerm);
    if (travelWaysPeople.length) return travelWaysPeople;
  }
  // Eagle Travel rooming lists are sent as Outlook email tables with surname/given-name
  // entries in the Names column and matching two-digit DOBs in the Age column.
  const hasEagleRoomingTable = /\bNames\b[\s\S]{0,200}\bAge\b[\s\S]{0,100}\bACC\b/i.test(text);
  if (hasEagleRoomingTable
    || /^eagle(?:\s*travel)?$/i.test(company.trim())
    || /(?:eagletvl\.com|Eagle\s+Travel)/i.test(text)) {
    const eaglePeople = extractEaglePeople(text);
    if (eaglePeople.length) return eaglePeople;
  }

  // AllTours hotel reservation forms store each guest in a titled table row:
  // "Mr SURNAME, GIVEN NAMES AGE". MSG attachments are indexed as extra pages,
  // so this same parser works for both standalone PDFs and Outlook attachments.
  if (/\balltours?\b/i.test(company.trim())
    || (/\bHOTEL\s+RESERVATION\s+FORM\b/i.test(text)
      && /\bSURNAME,\s*NAME\b/i.test(text)
      && /\bVOUCHER\s+NR\b/i.test(text))) {
    // The MSG may contain several independent AllTours vouchers, one per
    // PDF page. Keep each page as its own booking group and only return the
    // group whose voucher number or guest name matches the current search.
    const pageBreak = "\\n\\n--- ALLTOUR PAGE BREAK ---\\n\\n";
    const bookingPages = text.split(pageBreak).filter((page) => page.trim());
    const normalizedQuery = normalize(searchTerm);
    const matchingPages = normalizedQuery
      ? bookingPages.filter((page) => normalize(page).includes(normalizedQuery))
      : bookingPages;
    const alltourRowPattern = /\b(?:MR|MRS|MS|MISS|MSTR|MASTER)\.?\s+([\p{L}][\p{L}’', .-]{1,80}?)(?=\s+\d{1,3}\s|\s+Revise\s+Description\b|\s+NOTE:|\s+TOTAL\s+PAX\b|$)/giu;
    const alltourPeople = matchingPages.flatMap((page) =>
      Array.from(page.matchAll(alltourRowPattern), (match) => ({
        name: titleCaseName(match[1].trim()),
        dob: "",
      })).filter((person) => person.name.includes(",")),
    );
    if (alltourPeople.length) return alltourPeople;
  }

  // Biblio Globus reservation emails list each guest name followed by DOB.
  // A single MSG may contain many bookings (rooming lists), so isolate every
  // Ref# block first and only parse the block matching the searched reference.
  const isBiblioBooking = /^(?:biblio|biblo)(?:\s*globus(?:\s*egypt)?)?$/i.test(company.trim())
    || (/(?:Biblio|Biblo)\s+Globus/i.test(text)
      && /\bRef\s*#/i.test(text)
      && /\bDate\s+of\s+birth\b/i.test(text)
      && /\bNames\b/i.test(text));
  if (isBiblioBooking) {
    const refMatches = Array.from(text.matchAll(/\bRef\s*#/gi));
    const bookingBlocks = refMatches.map((match, index) => {
      const blockStart = match.index ?? 0;
      const blockEnd = refMatches[index + 1]?.index ?? text.length;
      const block = text.slice(blockStart, blockEnd);
      // The reference may follow a Hotel heading, or Flight Number/Arrival
      // Time fields in a final rooming list. Read it from the whole block.
      const reference = block.match(/\b\d{6,}(?:-\d+)?\b/)?.[0] || "";
      return { block, reference };
    }).filter((item) => item.reference);

    const normalizedSearch = normalize(searchTerm);
    const queryAsReference = normalizedSearch.replace(/[^a-z0-9]/gi, "");
    const matchingBlocks = normalizedSearch
      ? bookingBlocks.filter(({ block, reference }) => {
          const normalizedReference = reference.replace(/[^a-z0-9]/gi, "");
          return (normalizedReference && queryAsReference === normalizedReference)
            || normalize(block).includes(normalizedSearch);
        })
      : bookingBlocks;

    const biblioRowPattern = /([\p{L}][\p{L}'’.-]*(?:\s+[\p{L}][\p{L}'’.-]*){0,5}\s*\/\s*(?:MR|MRS|MS|MISS|CHLD|CHD|INF|MSTR))\s+(\d{1,2}[./-]\d{1,2}[./-]\d{4})\b/giu;
    const biblioPeople = matchingBlocks.flatMap(({ block }) => {
      // Names and DOBs are sequential rows after their respective headings.
      // Bound extraction to this booking block to avoid leaking guests from
      // the next reservation in a multi-booking rooming-list email.
      const section = block.match(/\bNames\b[\s\S]*?\bDate\s+of\s+birth\b([\s\S]*?)(?=\bIn\s+respect\s+of\s+our\s+guests\b|\bThanks\s+and\s+Best\s+regards\b|$)/i)?.[1] || "";
      return Array.from(section.matchAll(biblioRowPattern), (match) => {
        const rawName = match[1].trim();
        const nameAndTitle = rawName.match(/^([\s\S]+?)\s*\/\s*(MR|MRS|MS|MISS|CHLD|CHD|INF|MSTR)$/i);
        const displayName = nameAndTitle
          ? titleCaseName(nameAndTitle[1]) + " /" + nameAndTitle[2][0].toUpperCase() + nameAndTitle[2].slice(1).toLowerCase()
          : titleCaseName(rawName);
        return { name: displayName, dob: match[2].replace(/[/-]/g, ".") };
      });
    });
    if (biblioPeople.length) return biblioPeople;
  }

  // EasyJet bookings arrive as Outlook MSG files. Guest names are in the
  // email body under "Names: Age"; the attached PDF is not the source.
  if (/^easy\s*jet$/i.test(company.trim())) {
    const body = text.replace(/[\t|]+/g, " ").replace(/\s+/g, " ").trim();
    const namesSection = body.match(/\bNames\s*:\s*Age\s+([\s\S]*?)(?=\bRoom\s+Taken\s+from\s+Allocation\b|\bFlight\s+Arrival\s+Details\b|\bVoucher\s+attached\b|\bBooking\s+date\b|$)/i)?.[1] || "";
    // Find each title first, then take the text up to the next titled guest.
    // This avoids losing later guests when Outlook flattens line breaks.
    const titlePattern = /\b(?:Mrs|Mr|Ms|Miss|Master)\.?\s+/giu;
    const titleMatches = Array.from(namesSection.matchAll(titlePattern));
    return titleMatches.map((match, index) => {
      const start = (match.index ?? 0) + match[0].length;
      const end = titleMatches[index + 1]?.index ?? namesSection.length;
      const name = namesSection.slice(start, end)
        .replace(/\s+/g, " ")
        .replace(/[^\p{L}\p{M}'’.-]+$/gu, "")
        .trim();
      return { name: titleCaseName(name), dob: "" };
    }).filter((person) =>
      person.name
      && /^[\p{L}\p{M}'’.-]+(?:\s+[\p{L}\p{M}'’.-]+){1,4}$/u.test(person.name),
    );
  }

  // SUN International Outlook attachment: HOTEL C/IN LIST.
  // Voucher identifies a booking; following titled rows without a repeated
  // Voucher belong to it until another booking code appears.
  const isSunCheckInList = /\bHOTEL\s+C\/IN\s+LIST\b/i.test(text)
    && /\bVoucher\b/i.test(text)
    && /\bSurname,\s*Name\b/i.test(text)
    && /\bAge\/B\.Date\b/i.test(text);
  if (isSunCheckInList && enableSunCheckInList) {
    type SunCheckInGroup = { voucher: string; people: { name: string; dob: string }[] };
    const groups: SunCheckInGroup[] = [];
    const groupsByVoucher = new Map<string, SunCheckInGroup>();
    let current: SunCheckInGroup | null = null;
    const titlePattern = /\b(MR|MRS|MS|MISS|MSTR|MASTER|CHD|CHILD|INF)\.?\s+(.+?)(?=\s+ARR\+?\b|\s+(?:SINGLE|DOUBLE|TRIPLE|QUAD)\s+ROOM\b|$)/i;

    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.replace(/\s+/g, " ").trim();
      if (!line) continue;
      const guestMatch = titlePattern.exec(line);
      if (!guestMatch) continue;
      const beforeGuest = line.slice(0, guestMatch.index);
      const voucherMatch = beforeGuest.match(/\b([A-Z0-9]{5,10})\s+\d+\s*$/i)
        || beforeGuest.match(/\b([A-Z0-9]{5,10})\b/i);
      if (voucherMatch) {
        const voucher = voucherMatch[1].toUpperCase();
        current = groupsByVoucher.get(voucher) || { voucher, people: [] };
        if (!groupsByVoucher.has(voucher)) { groupsByVoucher.set(voucher, current); groups.push(current); }
      }
      if (!current) continue;
      // Only read DOB from the guest cell before the ARR/status column.
      // Dates later on the line are arrival/departure dates and must not be used as DOB.
      const guestCell = guestMatch[2].replace(/\s+(?:ARR\+?|NEW|CHANGED)\b.*$/i, "")
        .replace(/\s+(?:SINGLE|DOUBLE|TRIPLE|QUAD)\s+ROOM\b.*$/i, "").trim();
      const dobMatch = guestCell.match(/\b(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\b/);
      const nameBeforeDob = dobMatch
        ? guestCell.slice(0, dobMatch.index)
        : guestCell.replace(/\s+-\s*$/, "");
      // Age may share the same guest cell with the name and DOB (e.g.
      // "VIVIANA SEYBOLD 36 13.02.1989"); do not append it to the name.
      const rawName = nameBeforeDob.replace(/\s+\d{1,3}\s*\/?\s*$/, "")
        .replace(/\s+/g, " ").replace(/^[,\s]+|[,\s]+$/g, "").replace(/,/g, " ").trim();
      if (!rawName || /^(?:SURNAME NAME|NAME|AGE)$/i.test(rawName)) continue;
      current.people.push({ name: titleCaseName(rawName), dob: dobMatch ? dobMatch[1].replace(/[/-]/g, ".") : "" });
    }

    const normalizedQuery = normalize(searchTerm);
    if (!normalizedQuery) return groups.flatMap((group) => group.people);
    const compactQuery = normalizedQuery.replace(/\s+/g, "");
    if (/^[a-z0-9]{5,10}$/i.test(compactQuery)) {
      const match = groups.find((group) => group.voucher.toLowerCase() === compactQuery.toLowerCase());
      return match?.people || [];
    }
    const searchTokens = getSunSearchTokens(normalizedQuery);
    const matchingGroups = groups.filter((group) => group.people.some((person) => {
      const name = normalize(person.name);
      return name.includes(normalizedQuery)
        || (searchTokens.length > 0 && searchTokens.every((token) =>
          name.split(/\s+/).some((part) => part.includes(token)),
        ));
    }));
    return matchingGroups.flatMap((group) => group.people);
  }

  const clean = text.replace(/[\t|]+/g, " ").replace(/\s+/g, " ").trim();

  // Red Sea Tours Outlook bookings: each booking block contains guest names
  // written in French style, e.g. "MR BOUGAULT DOMINIQUE 69 ans".
  // Keep each repeated booking reference as a separate group so a name search
  // returns all guests belonging to that booking, not guests from other rooms.
  if (/^red\s*sea(?:\s*tours)?$/i.test(company.trim())
    || /redseatours-eg\.com/i.test(text)) {
    const bookingChunks = text.split(/(?:^|\r?\n)\s*\d{5,10}\s*(?=\r?\n)/);
    const redSeaGroups = bookingChunks.map((chunk) => {
      const rowPattern = /\b(?:MR|MM|MRS|MS)\.?\s+([\p{L}\p{M}][\p{L}\p{M}'’.-]*(?:\s+[\p{L}\p{M}][\p{L}\p{M}'’.-]*){1,5})\s+\d{1,3}\s+ans\b/giu;
      return Array.from(chunk.matchAll(rowPattern), (match) => ({
        name: titleCaseName(match[1].trim()),
        dob: "",
      }));
    }).filter((group) => group.length > 0);
    if (redSeaGroups.length) {
      const normalizedSearch = normalize(searchTerm);
      const matchingGroup = redSeaGroups.find((group) => !normalizedSearch || group.some((person) => {
        const nameParts = normalize(person.name).split(/\s+/);
        const queryParts = normalizedSearch.split(/\s+/).filter(Boolean);
        return queryParts.length > 0 && queryParts.every((token) =>
          nameParts.some((part) => part.includes(token)),
        );
      }));
      return matchingGroup || [];
    }
  }

  // W2M Outlook bookings are parsed from the fully decoded message body.
  const isW2mBooking = /^w2m$/i.test(company.trim())
    || /noreply@w2m\.com|world\s*2\s*meet|world2meet/i.test(clean)
    || (/\bBooking\s+Code\b/i.test(clean)
      && /\bPassenger\s+Name\b/i.test(clean)
      && /\bPassenger\s+Last\s+Name\b/i.test(clean));
  if (isW2mBooking) {
    const w2mPeople = extractW2mPeople(clean, searchTerm);
    if (w2mPeople.length) return w2mPeople;
  }

  // TUI Destimo voucher: the PDF text extractor may emit the room columns
  // before the guest rows, even though the visual table places names under
  // the Name header. Therefore scan the remainder of the page, not the text
  // between the Name and Room headers.
  const isTuiVoucher = /\bTUI\s+Ref\s*:/i.test(clean)
    && /\bSuper\s+PNR\s*:/i.test(clean)
    && /\bRoom\s+types\s*\//i.test(clean)
    && /\bName\s+Age\s+Arrival\s+Departure\b/i.test(clean);
  if (isTuiVoucher) {
    const nameHeader = clean.search(/\bName\s+Age\s+Arrival\s+Departure\b/i);
    const guestSection = nameHeader >= 0
      ? clean.slice(nameHeader + "Name Age Arrival Departure".length)
      : "";
    const tuiRowPattern = /([\p{L}\p{M}][\p{L}\p{M}'’.-]{1,50})\s*\/\s*([\p{L}\p{M}][\p{L}\p{M}'’ .-]{0,60}?)\s*\(([FM])\)/gu;
    const tuiPeople = Array.from(guestSection.matchAll(tuiRowPattern), (match) => ({
      name: titleCaseName(`${match[1].trim()} ${match[2].trim()}`),
      dob: "",
    })).filter((person) => person.name);
    if (tuiPeople.length) {
      const normalizedSearch = normalize(searchTerm);
      const matchesVoucher = !normalizedSearch || tuiPeople.some((person) => {
        const name = normalize(person.name);
        return name.includes(normalizedSearch)
          || normalizedSearch.split(/\s+/).filter(Boolean).every((token) =>
            name.split(/\s+/).some((part) => part.includes(token)),
          );
      });
      return matchesVoucher ? tuiPeople : [];
    }
  }

  // tez-tour reservation sheet:
  // Guest rows are printed as Title, Surname, Given name(s), Date of birth.
  // Parse only titled rows with a complete DOB so column headings such as
  // "Guest Information" and "Checkin Date" can never be mistaken for guests.
  const isTezVoucher = /^tez$/i.test(company.trim())
    || (/\bNEW\s+RESERVATION\b/i.test(clean)
      && /\bVoucher\s+No\b/i.test(clean)
      && /\bGuest\s+Information\b/i.test(clean)
      && /\bCheckin\s+Date\b/i.test(clean)
      && /\bCheckout\s+Date\b/i.test(clean));
  if (isTezVoucher) {
    const tezRowPattern = /\b(?:MR|MRS|MS|MISS|MSTR|MASTER)\.?\s+([A-Z][A-Z'’.-]{1,40})\s+([A-Z][A-Z'’.-]*(?:\s+[A-Z][A-Z'’.-]*){0,2})\s+(\d{1,2}[./-]\d{1,2}[./-]\d{4})\b/g;
    const tezPeople = Array.from(clean.matchAll(tezRowPattern), (match) => ({
      name: titleCaseName(match[1] + " " + match[2]),
      dob: match[3].replace(/[/-]/g, "."),
    }));
    if (tezPeople.length) return tezPeople;
  }

  // FUN&SUN / FUN voucher:
  // Passenger rows use the columns Title, Surname/Name, Age, Birthdate,
  // Arrival, Hour, Departure, Hour, Passport. The flight and passport
  // columns follow the DOB, so the generic titled-name parser cannot
  // safely identify the end of a guest row. Anchor each guest on its DOB.
  const isFunSunVoucher = /(?:FUN\s*&\s*SUN|FUN\s+SUN|FUN\s+SUN\s+TRAVEL|EX\s+TUI\s+RUSSIA)/i.test(clean)
    || /^fun(?:\s*\&?\s*sun)?$/i.test(company.trim());
  if (isFunSunVoucher && /\bPassenger\s+Informations\b/i.test(clean)
    && /\bBirthdate\b/i.test(clean)) {
    const passengerStart = clean.search(/\bPassenger\s+Informations\b/i);
    const passengerSection = clean.slice(passengerStart)
      .split(/\b(?:Agency\s+Note|Hotel\s+Notes|Agency\s+Name|Agency\s+User|Sejour\s+Hotel\s+Name)\b/i)[0];
    const funSunRowPattern = /\b(MR|MRS|MS|MISS|MSTR|MASTER|CHD|CHILD|INF|ADT)\.?\s+([\p{L}][\p{L}\p{M}'’., -]{1,65}?)\s+-\s+(\d{1,2}[./-]\d{1,2}[./-]\d{4})\b/giu;
    const funSunPeople = Array.from(passengerSection.matchAll(funSunRowPattern), (match) => ({
      name: titleCaseName(match[2].replace(/[,]+/g, " ").replace(/\s+/g, " ").trim()),
      dob: match[3].replace(/[/-]/g, "."),
    })).filter((person) => person.name && !/^(?:surname name|name age|age)$/i.test(person.name));

    if (funSunPeople.length) {
      const normalizedSearch = normalize(searchTerm);
      const compactSearch = normalizedSearch.replace(/\s+/g, "");
      // Room/confirmation searches identify the voucher in Multiple View;
      // return every passenger in that voucher. A name search must also
      // return the complete passenger group once any guest matches.
      const matchesVoucher = !normalizedSearch
        || /^\d{3,9}$/.test(compactSearch)
        || funSunPeople.some((person) => {
          const nameParts = normalize(person.name).split(/\s+/).filter(Boolean);
          const queryParts = normalizedSearch.split(/\s+/).filter(Boolean);
          return normalize(person.name).includes(normalizedSearch)
            || (queryParts.length > 0 && queryParts.every((token) =>
              nameParts.some((part) => part.includes(token)),
            ));
        });
      return matchesVoucher ? funSunPeople : [];
    }
  }

  // SUN International / Sunbug / Hotel2Sejour passenger table.
  // The table headings are sufficient to identify this format even when the
  // supplier/company heading or the "Passenger Informations" label is absent
  // from PDF text extraction.
  const sunSectionIndex = clean.search(/passenger\s+informations/i);
  const hasSunPassengerColumns = /surname\s*,?\s*name/i.test(clean)
    && /\bbirthdate\b/i.test(clean)
    && /\btitle\b/i.test(clean)
    && /\bage\b/i.test(clean);
  if (hasSunPassengerColumns) {
    const passengerSection = (sunSectionIndex >= 0 ? clean.slice(sunSectionIndex) : clean)
      .split(/\b(?:Agency\s+Note|Hotel\s+Notes|Agency\s+Name|Agency\s+User|Sejour\s+Hotel\s+Name)\b/i)[0];
    // Row order: Title, Surname/Name, Age, Birthdate. A dash is a real empty
    // field, not a reason to drop the passenger or infer a date.
    const sunRowPattern = /\b(?:MRS|MR|MS|MISS|MSTR|MASTER|CHD|CHILD|INF|ADT|ADULT)\.?\s+([\p{L}][\p{L}\p{M}\s,.'’\-]{1,65}?)\s+(-|\d{1,3})\s+(-|\d{1,2}[./-]\d{1,2}[./-]\d{2,4})(?=\s|$)/giu;
    const sunPeople = Array.from(passengerSection.matchAll(sunRowPattern), (match) => ({
      name: titleCaseName(match[1].replace(/\s+/g, " ").replace(/^[,\s]+|[,\s]+$/g, "").trim()),
      // Empty DOB stays empty; the SUN card renderer displays the required
      // trailing hyphen without inventing a date.
      dob: match[3] === "-" ? "" : match[3].replace(/[.-]/g, "/"),
    })).filter((person) => person.name && !/^(?:surname name|name|age)$/i.test(person.name));
    if (sunPeople.length) {
      const normalizedSearch = normalize(searchTerm);
      const searchTokens = getSunSearchTokens(normalizedSearch);
      const matchesVoucher = !normalizedSearch
        || /^\d{5,12}$/.test(normalizedSearch.replace(/\s+/g, ""))
        || sunPeople.some((person) => normalize(person.name).includes(normalizedSearch)
          || (searchTokens.length > 0 && searchTokens.every((token) =>
            normalize(person.name).split(/\s+/).some((part) => part.includes(token)),
          )));
      return matchesVoucher ? sunPeople : [];
    }
  }


  // Odeon voucher: numbered tourist rows use SURNAME/GIVEN-NAME,
  // followed by Adult/Child/Infant, title, and date of birth.
  // Keep detection tolerant because PDF text extraction may omit or reorder
  // some column headings while preserving the actual tourist rows.
  const hasOdeonMarkers = /\b(?:voucher\s*no|operator\s+voucher\s+no)\b/i.test(clean)
    && /\btourists\b/i.test(clean);
  if (hasOdeonMarkers) {
    const voucherMatch = clean.match(/\bVoucher\s*No\s*[:#-]?\s*(\d{5,12})\b/i);
    const operatorVoucherMatch = clean.match(/\bOperator\s+Voucher\s*No\s*[:#-]?\s*(\d{5,12})\b/i);
    const touristsStart = clean.search(/\bTourists\b/i);
    const afterTourists = clean.slice(touristsStart + "Tourists".length);
    const flightOffset = afterTourists.search(/\bFlight\b/i);
    const touristsSection = flightOffset >= 0 ? afterTourists.slice(0, flightOffset) : afterTourists;

    // Capture surname and given name separately. Allow optional spaces around
    // the slash and tolerate punctuation/spacing variations in PDF extraction.
    const odeonRowPattern = /(?:^|\s)(\d{1,2})\s+([\p{L}][\p{L}'-]{1,35})\s*\/\s*([\p{L}][\p{L}\s.'’'-]{0,45}?)\s+(Adult|Child|Infant)\s*-\s*(?:Mr|Mrs|Ms|Miss)\.?\s+(\d{1,2}[./-]\d{1,2}[./-]\d{4}|-)(?=\s|$)/giu;
    const odeonPeople = Array.from(touristsSection.matchAll(odeonRowPattern), (match) => {
      const surname = match[2].trim();
      const givenNames = match[3].trim();
      return {
        sourceName: surname + "/" + givenNames,
        name: titleCaseName(givenNames + " " + surname),
        dob: match[5] === "-" ? "لم يُعثر عليه" : match[5].replace(/[.-]/g, "/"),
      };
    });
    if (odeonPeople.length) {
      const normalizedSearch = normalize(searchTerm);
      const reservationQuery = normalizedSearch.replace(/\s+/g, "");
      if (!normalizedSearch) return odeonPeople.map(({ name, dob }) => ({ name, dob }));
      if (/^\d{5,12}$/.test(reservationQuery)) {
        const ids = [voucherMatch && voucherMatch[1], operatorVoucherMatch && operatorVoucherMatch[1]].filter(Boolean);
        return ids.includes(reservationQuery)
          ? odeonPeople.map(({ name, dob }) => ({ name, dob }))
          : [];
      }
      const matchingPeople = odeonPeople.filter((person) => {
        const source = normalize(person.sourceName.replace("/", " "));
        const display = normalize(person.name);
        const tokens = normalizedSearch.split(/\s+/).filter(Boolean);
        return source.includes(normalizedSearch) || display.includes(normalizedSearch)
          || (tokens.length > 0 && tokens.every((token) =>
            source.split(/\s+/).some((part) => part.includes(token))
            || display.split(/\s+/).some((part) => part.includes(token)),
          ));
      });
      return matchingPeople.length
        ? odeonPeople.map(({ name, dob }) => ({ name, dob }))
        : [];
    }
  }

  // Pegas hotel booking voucher: columns Title, Last Name, First Name,
  // Date of birth. Return every guest row on this page, even when the search
  // term matched another page of the same booking.
  const isPegasVoucher = /\blast\s+name\b/i.test(clean)
    && /\bfirst\s+name\b/i.test(clean)
    && /\bdate\s+of\s+birth\b/i.test(clean);
  if (isPegasVoucher) {
    const pegasRowPattern = /\b(MRS|MR|MS|MISS|MSTR|MISTER|MASTER)\s+([\p{L}][\p{L}'’.-]{1,45})\s+([\p{L}][\p{L}'’.-]{1,45}(?:\s+[\p{L}][\p{L}'’.-]{1,45}){0,3})\s+(\d{1,2}[./-]\d{1,2}[./-]\d{4})\b/giu;
    const pegasPeople = Array.from(clean.matchAll(pegasRowPattern), (match) => ({
      name: titleCaseName([match[1], match[2], match[3]].join(" ")),
      dob: match[4].replace(/[/-]/g, "."),
    }));
    if (pegasPeople.length) return pegasPeople;
  }

  // Anex alternative voucher: each guest is printed as a comma-separated line:
  // MRS, SURNAME GIVEN-NAME (Citizenship), DD/MM/YYYY, (Age), Passport: ...
  // Parse complete guest rows so footer dates and other numbers are ignored.
  const anexAlternativeRows = /\b(?:MRS|MR|MS|MISS|MSTR|CHD|INF|ADT|ADULT|CHILD)\s*,?\s*([A-Z][A-Z\s.'’-]{1,65}?)\s*\([^)]+\)\s*,\s*(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\s*,\s*\(\d{1,3}\)(?:\s*,\s*Passport\s*:)?/gi;
  // In Anex voucher tables, the Res.No column heading appears only once.
  // Each booking starts with: row number + reservation number + status + check-in date.
  // Keep all guest rows between this marker and the next booking marker together.
  const bookingStarts = Array.from(
    clean.matchAll(/(?:^|\s)(\d{1,2})\s+(\d{7,8})\s+(?:new|changed)\s+\d{1,2}[./-]\d{1,2}[./-]\d{2,4}/gi),
    (match) => ({ index: (match.index ?? 0) + (match[0].length - match[0].trimStart().length), reservationNo: match[2] }),
  );
  const bookingGroups = bookingStarts.map((start, index) => {
    const end = bookingStarts[index + 1]?.index ?? clean.length;
    const bookingText = clean.slice(start.index, end);
    const people = Array.from(bookingText.matchAll(anexAlternativeRows), (match) => ({
      sourceName: match[1].trim(),
      name: titleCaseAnexName(match[1]),
      dob: match[2].replace(/[.-]/g, "/"),
    }));
    return { reservationNo: start.reservationNo, people };
  }).filter((group) => group.people.length > 0);

  const alternativePeople = bookingGroups.length
    ? bookingGroups.flatMap((group) => group.people.map((person) => ({
        ...person,
        reservationNo: group.reservationNo,
      })))
    : Array.from(clean.matchAll(anexAlternativeRows), (match) => ({
        sourceName: match[1].trim(),
        name: titleCaseAnexName(match[1]),
        dob: match[2].replace(/[.-]/g, "/"),
        reservationNo: "",
      }));

  if (alternativePeople.length) {
    const normalizedSearch = normalize(searchTerm);
    if (!normalizedSearch) {
      return alternativePeople.map(({ name, dob }) => ({ name, dob }));
    }

    // A 7- or 8-digit query is treated as an Anex reservation number.
    // Return every guest belonging to that exact reservation only.
    const reservationQuery = normalizedSearch.replace(/\s+/g, "");
    if (/^\d{7,8}$/.test(reservationQuery)) {
      const matchingReservation = bookingGroups.find(
        (group) => group.reservationNo === reservationQuery,
      );
      return matchingReservation
        ? matchingReservation.people.map(({ name, dob }) => ({ name, dob }))
        : [];
    }

    // Find the booking containing the searched guest, then return all guests
    // from that same booking (not guests from adjacent reservations).
    // Match both the original surname-first spelling and the display spelling
    // (Anex commonly prints SURNAME GIVEN-NAME, while the UI reverses the order).
    const matchesGuest = (person: { sourceName: string; name: string; dob: string }) => {
      const source = normalize(person.sourceName || "");
      const display = normalize(person.name);
      const sourceTokens = source.split(/\\s+/).filter(Boolean);
      const queryTokens = normalizedSearch.split(/\\s+/).filter(Boolean);
      return source.includes(normalizedSearch)
        || display.includes(normalizedSearch)
        || (queryTokens.length > 0 && queryTokens.every((token) =>
          sourceTokens.some((part) => part.includes(token)) ||
          display.split(/\\s+/).some((part) => part.includes(token)),
        ));
    };

    const matchingGroups = bookingGroups.filter((group) =>
      group.people.some(matchesGuest),
    );
    if (matchingGroups.length) {
      return matchingGroups.flatMap((group) =>
        group.people.map(({ name, dob }) => ({ name, dob })),
      );
    }

    return alternativePeople
      .filter(matchesGuest)
      .map(({ name, dob }) => ({ name, dob }));
  }

  // Anex primary voucher: table with Clients names, citizenship / Date of born / Age.
  if (/clients\s*names\s*,?\s*citizenship/i.test(clean) && /date\s+of\s+born/i.test(clean)) {
    const anexRows = /\b(?:MRS|MR|MS|MISS|MSTR|CHD|INF|ADT|ADULT|CHILD)\b\s+([A-Z][A-Z\s.'’-]{1,65}?)\s*\([^)]+\)\s+(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\s+\d{1,3}(?=\s|$)/gi;
    const people = Array.from(clean.matchAll(anexRows), (match) => ({
      name: titleCaseAnexName(match[1]),
      dob: match[2].replace(/[.-]/g, "/"),
    }));
    if (people.length) return people;
  }

  // Generic hotel rooming-list attachment fallback.
  // Some supplier PDFs place the guest name and DOB in separate visual rows.
  // Extract the titled name independently; attach a DOB only when it follows
  // that same name before another guest/title or booking field begins.
  const titledAttachmentPattern = /\\b(MR|MRS|MS|MISS|MSTR|MASTER|CHD|CHLD)\\.?\\s+([\\p{L}][\\p{L}’'.,-]*(?:\\s+[\\p{L}][\\p{L}’'.,-]*){1,4}?)(?:\\s+(\\d{1,2}[./-]\\d{1,2}[./-]\\d{4})\\b)?(?=\\s+(?:MR|MRS|MS|MISS|MSTR|MASTER|CHD|CHLD)\\b|\\s+\\d{1,2}:\\d{2}\\b|\\s+[A-Z]{1,3}\\d{4,}\\b|\\s+passport\\b|$)/giu;
  const titledAttachmentPeople = Array.from(clean.matchAll(titledAttachmentPattern), (match) => ({
    name: titleCaseName(match[2].replace(/[,]+/g, " ").trim()),
    dob: match[3] ? match[3].replace(/[/-]/g, ".") : "",
  })).filter((person) => person.name && !/^(?:DOUBLE ROOM|STANDARD|PREMIUM)$/i.test(person.name));
  if (titledAttachmentPeople.length) {
    const normalizedSearch = normalize(searchTerm);
    if (!normalizedSearch || /^\\d{3,9}$/.test(normalizedSearch.replace(/\\s+/g, ""))) {
      return titledAttachmentPeople;
    }
    const tokens = normalizedSearch.split(/\\s+/)
      .filter((token) => !/^(?:mr|mrs|ms|miss|mstr|master|chd|chld)$/.test(token));
    const matchingPeople = titledAttachmentPeople.filter((person) => {
      const parts = normalize(person.name).split(/\\s+/);
      return normalize(person.name).includes(normalizedSearch)
        || (tokens.length > 0 && tokens.every((token) => parts.some((part) => part.includes(token))));
    });
    if (matchingPeople.length) return matchingPeople;
  }

  const datePattern = "(?:\\d{1,2}[\\/-]\\d{1,2}[\\/-]\\d{2,4}|\\d{4}[\\/-]\\d{1,2}[\\/-]\\d{1,2}|\\d{1,2}\\s+[A-Za-z]{3,9}\\s+\\d{4})";
  const dates: string[] = [];
  const dateRegex = new RegExp("(?:date\\s*of\\s*birth|birth\\s*date|dob|d\\.o\\.b\\.?|تاريخ\\s*الميلاد)\\s*[:#-]?\\s*(" + datePattern + ")", "gi");
  for (const match of clean.matchAll(dateRegex)) dates.push(match[1]);
  const names: string[] = [];
  const nameRegex = /(?:guest\s*name|passenger\s*name|full\s*name|name\s*of\s*guest|guest|passenger|الاسم|اسم\s*النزيل)\s*[:#-]?\s*([\p{L}][\p{L}\s'.-]{2,60}?)(?=\s+(?:date\s*of\s*birth|birth\s*date|dob|d\.o\.b\.?|passport|nationality|room|تاريخ\s*الميلاد)\b|[,;|]|$)/giu;
  for (const match of clean.matchAll(nameRegex)) {
    const candidate = match[1].trim();
    if (candidate && !names.some((name) => normalize(name) === normalize(candidate))) names.push(candidate);
  }
  if (!names.length && searchTerm.trim()) {
    const escaped = searchTerm.trim().replace(/[.*+?^\x24{}()|[\]\\]/g, "\\$&");
    const found = clean.match(new RegExp(escaped, "i"));
    if (found) names.push(found[0]);
  }
  return names.map((name, index) => ({
    name: titleCaseName(name),
    dob: dates[index] || (dates.length === 1 ? dates[0] : "لم يُعثر عليه"),
  }));
}


type SunIndexedFile = Pick<IndexedFile, "extension" | "pages" | "visualPages" | "content" | "company" | "name" | "path">;

function isW2mIndexedFile(file: Pick<IndexedFile, "company" | "content" | "pages"> | null | undefined) {
  if (!file) return false;
  return /^w2m$/i.test(file.company.trim())
    || /noreply@w2m\.com|world\s*2\s*meet|world2meet/i.test([file.content, ...file.pages].join(" "));
}

function isSunInternationalIndexedFile(file: SunIndexedFile | null | undefined) {
  if (!file) return false;
  const company = normalize(file.company);
  const searchable = [file.name, file.path, file.content, ...file.pages, ...(file.visualPages || [])].join(" ");
  const isFunSun = /^fun\s*&?\s*sun$/i.test(company)
    || /FUN\s*&\s*SUN|FUN\s+SUN|EX\s+TUI\s+RUSSIA/i.test(searchable);
  if (isFunSun) return false;
  const hasPassengerTable = /passenger\s+informations/i.test(searchable)
    && /surname\s*,?\s*name/i.test(searchable)
    && /\bbirthdate\b/i.test(searchable)
    && /\btitle\b/i.test(searchable)
    && /\bage\b/i.test(searchable);
  const hasCheckInList = /\bHOTEL\s+C\/IN\s+LIST\b/i.test(searchable)
    && /\bVoucher\b/i.test(searchable)
    && /\bSurname,\s*Name\b/i.test(searchable)
    && /\bAge\/B\.Date\b/i.test(searchable);
  return ["sun", "sun international", "sunbug", "sun bug"].includes(company)
    || /\bSUN\s+INTERNATIONAL\b|\bSUNBUG\b/i.test(searchable)
    || hasPassengerTable
    || hasCheckInList;
}

/**
 * Parse SUN batch PDFs page-by-page so a name or reservation search returns
 * only the matching reservation page(s), not passengers from every booking
 * in Hotel2Sejour / Final / Reservations files. For MSG files, inspect PDF
 * attachment pages before falling back to the email body.
 */
function extractPeopleForMultipleView(
  file: Pick<IndexedFile, "extension" | "pages" | "visualPages" | "content" | "company" | "name" | "path">,
  searchTerm: string,
  enableSunCheckInList = false,
) {
  const isMsg = file.extension.toLowerCase() === "msg";
  const isSun = isSunInternationalIndexedFile(file);

  if (isSun) {
    const sourcePages = isMsg
      ? file.pages.slice(1).filter((page) => page.trim())
      : (file.visualPages?.length ? file.visualPages : file.pages).filter((page) => page.trim());
    const filename = (file.name || file.path || "").split(/[\\/]/).pop() || "";
    const compactQuery = normalize(searchTerm).replace(/\s+/g, "");
    const numericFilename = /^\d+\.pdf$/i.test(filename);
    const queryIsNumeric = /^\d{5,12}$/.test(compactQuery);
    const filenameIsExactBooking = numericFilename
      && filename.replace(/\.pdf$/i, "") === compactQuery;
    const matchingPages = sourcePages.filter((page) => {
      if (!searchTerm.trim()) return true;
      if (filenameIsExactBooking) return true;
      return matchesSearchText(page, searchTerm) || arrivalNameMatchesText(searchTerm, page);
    });
    const pagePeople = matchingPages.flatMap((page) =>
      extractPeople(page, searchTerm, file.company, true),
    );
    if (pagePeople.length) return pagePeople;

    // A numeric single-voucher PDF is itself the booking identity, even when
    // the reservation number is printed only in the filename.
    if (filenameIsExactBooking && queryIsNumeric) {
      return sourcePages.flatMap((page) => extractPeople(page, searchTerm, file.company, true));
    }

    if (isMsg) {
      const emailBody = file.pages[0] || file.content || "";
      return extractPeople(emailBody, searchTerm, file.company, true);
    }
    return [];
  }

  if (!isMsg) {
    const source = /alltour/i.test(file.company)
      ? file.pages.join("\n\n--- ALLTOUR PAGE BREAK ---\n\n")
      : file.pages.join("\n\n");
    return extractPeople(source || file.content || "", searchTerm, file.company, enableSunCheckInList);
  }

  const emailBody = file.pages[0] || file.content || "";
  const fromEmail = extractPeople(emailBody, searchTerm, file.company, enableSunCheckInList);
  if (fromEmail.length) return fromEmail;

  const attachmentPages = file.pages.slice(1).filter((page) => page.trim());
  if (!attachmentPages.length) return [];

  const attachmentText = /alltour/i.test(file.company)
    ? attachmentPages.join("\n\n--- ALLTOUR PAGE BREAK ---\n\n")
    : attachmentPages.join("\n\n");
  const fromAllAttachments = extractPeople(attachmentText, searchTerm, file.company, enableSunCheckInList);
  if (fromAllAttachments.length) return fromAllAttachments;

  // Last fallback: some voucher layouts are page-oriented and should not
  // accidentally combine rows from separate attachments/pages.
  return attachmentPages.flatMap((page) => extractPeople(page, searchTerm, file.company, enableSunCheckInList));
}

/**
 * Preserve the established extraction route used by Single View. The new
 * page-aware SUN resolver above is intentionally limited to Multiple View.
 */
function extractPeopleFromIndexedFile(
  file: Pick<IndexedFile, "extension" | "pages" | "content" | "company">,
  searchTerm: string,
  enableSunCheckInList = false,
) {
  const isMsg = file.extension.toLowerCase() === "msg";
  if (!isMsg) {
    const source = /alltour/i.test(file.company)
      ? file.pages.join("\n\n--- ALLTOUR PAGE BREAK ---\n\n")
      : file.pages.join("\n\n");
    return extractPeople(source || file.content || "", searchTerm, file.company, enableSunCheckInList);
  }

  const emailBody = file.pages[0] || file.content || "";
  const fromEmail = extractPeople(emailBody, searchTerm, file.company, enableSunCheckInList);
  if (fromEmail.length) return fromEmail;

  const attachmentPages = file.pages.slice(1).filter((page) => page.trim());
  if (!attachmentPages.length) return [];

  const attachmentText = /alltour/i.test(file.company)
    ? attachmentPages.join("\n\n--- ALLTOUR PAGE BREAK ---\n\n")
    : attachmentPages.join("\n\n");
  const fromAllAttachments = extractPeople(attachmentText, searchTerm, file.company, enableSunCheckInList);
  if (fromAllAttachments.length) return fromAllAttachments;

  return attachmentPages.flatMap((page) => extractPeople(page, searchTerm, file.company, enableSunCheckInList));
}

export default function GuestNameExtractorPage() {
  const [files, setFiles] = useState<IndexedFile[]>([]);
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<"single" | "multiple">("single");
  const [arrivalFrom, setArrivalFrom] = useState("");
  const [arrivalTo, setArrivalTo] = useState("");
  const [arrivalCompanyFilter, setArrivalCompanyFilter] = useState("all");
  const [multipleSort, setMultipleSort] = useState<"input" | "company" | "room">("input");
  const [multipleCopyStatus, setMultipleCopyStatus] = useState("");
  const [greenCards, setGreenCards] = useState<string[]>([]);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("guest-extractor-green-cards-v1") || "[]");
      if (Array.isArray(saved)) setGreenCards(saved.filter((item): item is string => typeof item === "string"));
    } catch { /* ignore invalid saved card colors */ }
  }, []);

  useEffect(() => {
    try { localStorage.setItem("guest-extractor-green-cards-v1", JSON.stringify(greenCards)); }
    catch { /* ignore unavailable local storage */ }
  }, [greenCards]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [folderName, setFolderName] = useState("");
  const [nativeFolderPath, setNativeFolderPath] = useState("");
  const [isDesktop, setIsDesktop] = useState(false);
  const [selected, setSelected] = useState<SearchResult | null>(null);
  const [msgPreview, setMsgPreview] = useState<MsgPreviewData | null>(null);
  const [msgPreviewError, setMsgPreviewError] = useState("");
  const [activeAttachment, setActiveAttachment] = useState<MsgAttachmentPreview | null>(null);
  const [attachmentSearchQuery, setAttachmentSearchQuery] = useState("");
  const [attachmentSearchMatches, setAttachmentSearchMatches] = useState<AttachmentSearchMatch[]>([]);
  const [attachmentSearchStatus, setAttachmentSearchStatus] = useState("");
  const [activeAttachmentPage, setActiveAttachmentPage] = useState(1);
  const [attachmentPdfSearchTerm, setAttachmentPdfSearchTerm] = useState("");
  useEffect(() => () => { msgPreview?.attachments.forEach((attachment) => URL.revokeObjectURL(attachment.url)); }, [msgPreview]);
  const [currentPage, setCurrentPage] = useState(1);
  const [restoreComplete, setRestoreComplete] = useState(false);
  const [storageMessage, setStorageMessage] = useState("جارٍ استعادة المجلد المحفوظ...");
  const [arrivals, setArrivals] = useState<ArrivalRecord[]>([]);
  const [arrivalReportName, setArrivalReportName] = useState("");
  const [arrivalStatus, setArrivalStatus] = useState("");
  const [arrivalBusy, setArrivalBusy] = useState(false);
  const arrivalInputRef = useRef<HTMLInputElement>(null);
  const nativeScanInProgressRef = useRef(false);

  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setIsDesktop(Boolean(window.desktopBridge)); }, []);

  useEffect(() => {
    if (!isDesktop || !nativeFolderPath || !window.desktopBridge) return;
    // Folder watcher notifications must never trigger a full re-index.
    // Searching is always performed against the in-memory index loaded once
    // when the app opens. The user can explicitly refresh if files changed.
    const unsubscribe = window.desktopBridge.onFolderChanged(() => {
      setStorageMessage("تم رصد تغيير في مجلد الحجوزات. نتائج البحث الحالية تستخدم الفهرس المحمّل؛ اضغط «فحص التحديثات» فقط إذا أردت إعادة الفهرسة.");
    });
    return () => {
      unsubscribe();
      void window.desktopBridge?.unwatchFolder();
    };
  }, [isDesktop, nativeFolderPath]);

  useEffect(() => {
    let active = true;
    async function restoreSession() {
      try {
        const savedState = JSON.parse(localStorage.getItem(GUEST_STATE_KEY) || "{}");
        const savedNativePath = window.desktopBridge ? localStorage.getItem(NATIVE_FOLDER_KEY) || "" : "";
        if (!active) return;
        const savedArrivals = JSON.parse(localStorage.getItem(ARRIVAL_REPORT_KEY) || "[]");
        if (Array.isArray(savedArrivals)) setArrivals(savedArrivals as ArrivalRecord[]);
        setFolderName(String(savedState.folderName || ""));
        setQuery(String(savedState.query || ""));
        setCurrentPage(Math.max(1, Number(savedState.currentPage) || 1));
        setNativeFolderPath(savedNativePath);
        setStorageMessage(savedNativePath
          ? "تم استعادة مسار مجلد الحجوزات. جارٍ قراءة الملفات الأصلية مباشرة..."
          : "اختر مجلد الحجوزات للبدء. لا يتم إنشاء قاعدة بيانات أو حفظ نسخ من الملفات.");
        if (savedNativePath && window.desktopBridge) void scanNativeFolder(savedNativePath);
      } catch {
        if (active) setStorageMessage("تعذرت استعادة مسار مجلد الحجوزات. اختر المجلد مرة أخرى.");
      } finally {
        if (active) setRestoreComplete(true);
      }
    }
    void restoreSession();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!restoreComplete) return;
    try {
      localStorage.setItem(GUEST_STATE_KEY, JSON.stringify({
        folderName,
        query,
        selectedId: selected?.id || null,
        currentPage,
      }));
    } catch { /* تجاهل تعذر حفظ حالة العرض */ }
  }, [restoreComplete, folderName, query, selected, currentPage]);

  const previewUrl = useMemo(() => selected
    ? URL.createObjectURL(new Blob([selected.file], { type: getPreviewMimeType(selected.extension) }))
    : "", [selected]);
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const results = useMemo<SearchResult[]>(() => {
    const q = normalize(query);
    if (!q) return [];

    // Resolve room/confirmation numbers through arr.pdf, then search by guest name.
    const linkedArrivalGuests = arrivals.filter((item) =>
      normalize(item.roomNo).replace(/\s+/g, "") === q.replace(/\s+/g, "")
      || normalize(item.confirmationNo).replace(/\s+/g, "") === q.replace(/\s+/g, "")
    );
    const isArrivalNumberSearch = linkedArrivalGuests.length > 0;
    const matchingArrivalNames = linkedArrivalGuests.map((item) => item.name);

    return files.flatMap((item) => {
      const matchedPages = item.pages.reduce<number[]>((acc, page, index) => {
        const searchable = [item.name, item.path, item.company, page].join(" ");
        const matchesLinkedGuest = matchingArrivalNames.some((name) => arrivalNameMatchesText(name, searchable));
        const matchesDirectQuery = !isArrivalNumberSearch && matchesSearchText(searchable, query);
        if (matchesDirectQuery || matchesLinkedGuest) {
          acc.push(index + 1);
        }
        return acc;
      }, []);
      if (!isArrivalNumberSearch && matchesSearchText([item.name, item.path, item.company].join(" "), query) && !matchedPages.length) {
        matchedPages.push(1);
      }
      return matchedPages.length ? [{ ...item, matchedPages }] : [];
    });
  }, [files, query, arrivals]);

  const arrivalMatches = useMemo(() => {
    const q = normalize(query).replace(/\\s+/g, "");
    if (!q || !arrivals.length) return [];
    return arrivals.filter((item) =>
      normalize(item.roomNo).replace(/\\s+/g, "").includes(q)
      || normalize(item.confirmationNo).replace(/\\s+/g, "").includes(q)
      || normalize(item.name).includes(normalize(query)),
    );
  }, [arrivals, query]);

  // Resolve each arr.pdf booking to the company folder containing its guest name.
  // This lets the arrival-time filter work by company without changing arr.pdf parsing.
  const arrivalCompanies = useMemo(() => {
    const companyByConfirmation = new Map<string, string>();
    for (const arrival of arrivals) {
      const matchedFile = files.find((candidate) =>
        candidate.pages.some((page) =>
          arrivalNameMatchesText(arrival.name, [candidate.name, candidate.path, candidate.company, page].join(" ")),
        ),
      );
      companyByConfirmation.set(arrival.confirmationNo, matchedFile?.company || "غير محددة");
    }
    return companyByConfirmation;
  }, [arrivals, files]);

  const arrivalCompanyOptions = useMemo(
    () => Array.from(new Set(Array.from(arrivalCompanies.values()))).sort((a, b) => a.localeCompare(b, "ar")),
    [arrivalCompanies],
  );

  const arrivalTimeMatches = useMemo(() => {
    if (!arrivalFrom && !arrivalTo && arrivalCompanyFilter === "all") return [];
    return arrivals.filter((item) =>
      (!arrivalFrom || item.arrivalTime >= arrivalFrom)
      && (!arrivalTo || item.arrivalTime <= arrivalTo)
      && (arrivalCompanyFilter === "all" || arrivalCompanies.get(item.confirmationNo) === arrivalCompanyFilter),
    ).sort((x, y) => x.arrivalTime.localeCompare(y.arrivalTime));
  }, [arrivals, arrivalFrom, arrivalTo, arrivalCompanyFilter, arrivalCompanies]);

  const multipleCards = useMemo(() => {
    const terms = query.split(/[，,;؛\\n]+/).map((part) => part.trim()).filter(Boolean);
    return terms.map((term, index) => {
      const compact = normalize(term).replace(/\\s+/g, "");
      const arrival = arrivals.find((item) =>
        normalize(item.roomNo).replace(/\\s+/g, "") === compact
        || normalize(item.confirmationNo).replace(/\\s+/g, "") === compact
        || (/[\\p{L}]/u.test(term) && normalize(item.name).includes(normalize(term)))
      ) || null;
      const matchingFiles = arrival
        ? files.filter((candidate) => candidate.pages.some((page) =>
            arrivalNameMatchesText(arrival.name, [candidate.name, candidate.path, candidate.company, page].join(" "))))
        : files.filter((candidate) => candidate.pages.some((page) =>
            matchesSearchText([candidate.name, candidate.path, candidate.company, page].join(" "), term)));
      const sunFiles = matchingFiles.filter((candidate) => isSunInternationalIndexedFile(candidate));
      const prioritizedSunFiles = [...sunFiles].sort((left, right) => {
        const priority = (candidate: IndexedFile) => {
          if (candidate.extension !== "pdf") return candidate.extension === "msg" ? 4 : 5;
          const filename = candidate.name.split(/[\\/]/).pop() || candidate.name;
          if (/^hotel2sejour\.pdf$/i.test(filename)) return 0;
          if (/^final\.pdf$/i.test(filename)) return 1;
          if (/^reservations\s*\(\s*\d+\s*\)\.pdf$/i.test(filename)) return 2;
          if (/^\d+\.pdf$/i.test(filename)) return 3;
          if (/\bHOTEL\s+C\/IN\s+LIST\b/i.test(candidate.content + " " + candidate.pages.join(" "))) return 4;
          return 5;
        };
        return priority(left) - priority(right);
      });
      const file = prioritizedSunFiles[0] || matchingFiles[0] || null;
      const people = file ? extractPeopleForMultipleView(file, arrival?.name || term, true) : [];
      // Preserve repeated SUN guest rows; keep existing de-duplication for other companies.
      const uniquePeople = file && (isSunInternationalIndexedFile(file) || isW2mIndexedFile(file))
        ? people
        : people.filter((person, personIndex, all) =>
            all.findIndex((candidate) => normalize(candidate.name) === normalize(person.name)
              && normalize(candidate.dob) === normalize(person.dob)) === personIndex);
      return { key: index + "-" + compact, term, arrival, file, people: uniquePeople };
    }).sort((left, right) => {
      if (multipleSort === "company") {
        const companyCompare = (left.file?.company || "غير محددة").localeCompare(
          right.file?.company || "غير محددة", "ar", { sensitivity: "base" },
        );
        if (companyCompare) return companyCompare;
      }
      if (multipleSort === "room" || multipleSort === "company") {
        const leftRoom = left.arrival?.roomNo || "";
        const rightRoom = right.arrival?.roomNo || "";
        return leftRoom.localeCompare(rightRoom, undefined, { numeric: true });
      }
      return 0;
    });
  }, [query, arrivals, files, multipleSort]);

  const companies = useMemo(() => new Set(files.map((file) => file.company).filter((name) => name !== "غير محددة")).size, [files]);
  const totalSize = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files]);
  // MSG files are email messages, not paginated documents. Always parse their
  // primary email body (pages[0]); currentPage may retain a page number from a
  // previously opened PDF or point to an indexed PDF attachment.
  const pageText = selected
    ? selected.extension.toLowerCase() === "msg"
      ? selected.pages[0] || ""
      : selected.pages[currentPage - 1] || ""
    : "";
  // AllTours booking references can be found on a different page from the
  // guest table. Parse the complete MSG/PDF page set for this company so a
  // search by voucher number still displays every guest in that booking.
  // When the search is a room or confirmation number, use the linked guest name
  // as the parser query. Passing the numeric identifier to a voucher parser can
  // make it match an unrelated number in the page and return a stray row.
  const arrivalSearchQuery = useMemo(() => {
    const q = normalize(query).replace(/\s+/g, "");
    if (!q) return "";
    const linked = arrivals.filter((item) =>
      normalize(item.roomNo).replace(/\s+/g, "") === q
      || normalize(item.confirmationNo).replace(/\s+/g, "") === q
    );
    return linked.map((item) => item.name).filter(Boolean).join(" ");
  }, [arrivals, query]);

  const effectivePeopleQuery = arrivalSearchQuery || query;
  const extractedPeople = useMemo(
    () => selected ? extractPeopleFromIndexedFile(selected, effectivePeopleQuery) : [],
    [selected, effectivePeopleQuery],
  );

  async function uploadArrivalReport(selectedFiles: FileList | null) {
    const file = selectedFiles?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setArrivalStatus("من فضلك اختر تقرير PDF بصيغة arr.pdf.");
      return;
    }
    setArrivalBusy(true);
    setArrivalStatus("جارٍ قراءة تقرير الوصول محلياً...");
    try {
      const parsed = await extractArrivalReport(file);
      if (!parsed.length) {
        setArrivalStatus("لم يتم العثور على سجلات وصول قابلة للقراءة. تأكد من أن التقرير يحتوي على أعمدة Room No. وName وConf No. وArr. Time.");
        return;
      }
      setArrivals(parsed);
      setArrivalReportName(file.name);
      localStorage.setItem(ARRIVAL_REPORT_KEY, JSON.stringify(parsed));
      setArrivalStatus(`تم استخراج ${parsed.length.toLocaleString("en-US")} حجز من التقرير ${file.name} وحفظ البيانات محلياً.`);
    } catch {
      setArrivalStatus("تعذرت قراءة التقرير. تأكد من سلامة ملف PDF ثم حاول مرة أخرى.");
    } finally {
      setArrivalBusy(false);
    }
  }

  function clearArrivalReport() {
    localStorage.removeItem(ARRIVAL_REPORT_KEY);
    setArrivals([]);
    setArrivalReportName("");
    setArrivalStatus("تم حذف بيانات تقرير الوصول المحفوظة من المتصفح.");
  }

  async function scanFolder(selectedFiles: FileList | null) {
    if (!selectedFiles?.length) return;
    const allFiles = Array.from(selectedFiles);
    const root = allFiles[0].webkitRelativePath?.split("/")[0] || "المجلد المحدد";
    const readable = allFiles.filter((file) => SUPPORTED.has(file.name.split(".").pop()?.toLowerCase() || ""));
    setBusy(true); setError(""); setWarnings([]); setFiles([]); setQuery(""); setSelected(null);
    setFolderName(root); setProgress({ done: 0, total: readable.length });
    const indexed: IndexedFile[] = []; const failed: string[] = [];
    for (let index = 0; index < readable.length; index++) {
      const file = readable[index]; const extension = file.name.split(".").pop()?.toLowerCase() || "";
      const path = file.webkitRelativePath || file.name;
      try {
        const extracted = await extractText(file, extension);
        const folderMetadata = getFolderMetadata(path);
        indexed.push({ id: path + "-" + file.lastModified + "-" + index, name: file.name, path,
          ...folderMetadata, extension, size: file.size, content: extracted.content,
          pages: extracted.pages, visualPages: extracted.visualPages, file });
      } catch { failed.push(path); }
      setProgress({ done: index + 1, total: readable.length });
    }
    setStorageMessage(`تمت قراءة ${indexed.length.toLocaleString("en-US")} ملف لهذه الجلسة فقط. لا يتم حفظ الملفات أو إنشاء قاعدة بيانات.`);
    setFiles(indexed); setWarnings(failed); setBusy(false);
    if (!readable.length) setError("لم أجد ملفات مدعومة داخل المجلد. الملفات المدعومة: PDF وWord DOCX وOutlook MSG وTXT وCSV وXML.");
    else if (!indexed.length) setError("تعذرت قراءة الملفات المحددة. تحقق من سلامة الملفات ثم حاول مرة أخرى.");
  }


  async function chooseNativeFolder() {
    if (!window.desktopBridge) {
      inputRef.current?.click();
      return;
    }
    try {
      const selectedPath = await window.desktopBridge.selectFolder();
      if (selectedPath) await scanNativeFolder(selectedPath);
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : "تعذر الوصول إلى المجلد المحدد.");
    }
  }

  async function scanNativeFolder(rootPath: string) {
    if (!window.desktopBridge) return;
    // Ignore duplicate folder-change events while a full indexing pass is running.
    if (nativeScanInProgressRef.current) return;
    nativeScanInProgressRef.current = true;
    setBusy(true); setError(""); setWarnings([]); setFiles([]); setQuery(""); setSelected(null);
    setNativeFolderPath(rootPath);
    setFolderName(rootPath);
    localStorage.setItem(NATIVE_FOLDER_KEY, rootPath);
    setStorageMessage("جارٍ فهرسة الملفات مباشرة من مجلد Windows دون رفعها أو نسخها إلى ذاكرة المتصفح...");
    setProgress({ done: 0, total: 0 });
    const indexed: IndexedFile[] = [];
    const failed: string[] = [];
    try {
      const entries = await window.desktopBridge.listFolderFiles(rootPath);
      const watchEnabled = await window.desktopBridge.watchFolder(rootPath);
      setProgress({ done: 0, total: entries.length });
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        const extension = entry.name.split(".").pop()?.toLowerCase() || "";
        try {
          const bytes = await window.desktopBridge.readFile(rootPath, entry.path);
          const file = new File([bytes.slice().buffer as ArrayBuffer], entry.name, { lastModified: entry.mtimeMs });
          const extracted = await extractText(file, extension);
          const folderMetadata = getNativeFolderMetadata(entry.relativePath);
          indexed.push({
            id: entry.path + "-" + entry.mtimeMs,
            name: entry.name,
            path: entry.path,
            ...folderMetadata,
            extension,
            size: entry.size,
            content: extracted.content,
            pages: extracted.pages,
            visualPages: extracted.visualPages,
            file,
          });
        } catch {
          failed.push(entry.relativePath);
        }
        // Avoid thousands of React renders; update progress in small batches.
        if ((index + 1) % 10 === 0 || index === entries.length - 1) {
          setProgress({ done: index + 1, total: entries.length });
        }
        // Yield to Chromium so the window can paint and respond to user input.
        if ((index + 1) % 5 === 0) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        }
      }
      setFiles(indexed);
      setWarnings(failed);
      setStorageMessage(`تم فهرسة ${indexed.length.toLocaleString("en-US")} ملف من المجلد الأصلي مباشرة. ${watchEnabled ? "مراقبة التغييرات والإضافات الجديدة مفعّلة." : "تعذر تفعيل المراقبة التلقائية؛ استخدم زر فحص التحديثات عند إضافة ملفات."} لن يتم نسخ الملفات إلى ذاكرة المتصفح.`);
      if (!entries.length) setError("لم أجد ملفات مدعومة داخل المجلد المحدد.");
      else if (!indexed.length) setError("تعذرت قراءة الملفات. تحقق من صلاحيات المجلد أو سلامة الملفات.");
      else if (entries.length >= 20000) setError("تم الوصول إلى حد الفهرسة البالغ 20,000 ملف. اختر مجلداً فرعياً لتقليل نطاق البحث.");
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : "تعذرت قراءة المجلد المحدد.");
      setStorageMessage("تعذرت فهرسة المجلد. تحقق من اتصال القرص أو صلاحيات الوصول.");
    } finally {
      nativeScanInProgressRef.current = false;
      setBusy(false);
    }
  }


  function openPreview(item: SearchResult) {
    setSelected(item);
    setCurrentPage(item.matchedPages[0] || 1);
    setMsgPreview(null);
    setMsgPreviewError("");
    setActiveAttachment(null);
    if (item.extension.toLowerCase() !== "msg") return;
    void (async () => {
      try {
        const { MsgReader } = await import("@kenjiuno/msgreader-web-ng");
        const reader = new MsgReader(await item.file.arrayBuffer());
        const data = reader.getFileData() as unknown as Record<string, unknown>;
        const recipients = Array.isArray(data.recipients) ? data.recipients as Array<Record<string, unknown>> : [];
        const names = (kind: string) => recipients
          .filter((recipient) => String(recipient.recipType || "to").toLowerCase() === kind)
          .map((recipient) => String(recipient.name || recipient.email || "").trim())
          .filter(Boolean).join("; ");
        const attachmentRows = Array.isArray(data.attachments) ? data.attachments as Array<Record<string, unknown>> : [];
        const msgReader = reader as unknown as {
          getAttachment: (attachment: unknown) => { fileName?: string; content: Uint8Array };
        };
        const attachments: MsgAttachmentPreview[] = attachmentRows.map((row) => {
          const extracted = msgReader.getAttachment(row);
          const name = String(extracted.fileName || row.fileName || row.name || "attachment");
          const extension = name.split(".").pop()?.toLowerCase() || "";
          const mimeByExtension: Record<string, string> = {
            pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
            gif: "image/gif", webp: "image/webp", txt: "text/plain", csv: "text/csv",
            html: "text/html", htm: "text/html",
            docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          };
          // Outlook/MSG قد يضع application/octet-stream حتى لو كان الامتداد صورة.
          // نثق بنوع MIME الصريح إذا كان مفيدًا، وإلا نستنتجه من امتداد الملف.
          const declaredMime = String(row.attachMimeTag || "").split(";")[0].trim().toLowerCase();
          const mime = declaredMime && declaredMime !== "application/octet-stream"
            ? declaredMime
            : (mimeByExtension[extension] || declaredMime || "application/octet-stream");
          const blob = new Blob([new Uint8Array(extracted.content).buffer as ArrayBuffer], { type: mime });
          return { name, type: mime, blob, url: URL.createObjectURL(blob), size: blob.size };
        });
        const html = typeof data.bodyHtml === "string" ? data.bodyHtml : "";
        const safeHtml = html
          .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
          .replace(/\s on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
          .replace(/javascript\s*:/gi, "");
        const sentValue = data.messageDeliveryTime || data.clientSubmitTime || data.creationTime || "";
        setMsgPreview({
          subject: String(data.subject || item.name),
          sender: String(data.senderName || data.senderEmail || ""),
          senderEmail: String(data.senderEmail || ""),
          to: names("to") || recipients.map((recipient) => String(recipient.name || "")).filter(Boolean).join("; "),
          cc: names("cc"),
          sent: sentValue ? new Date(String(sentValue)).toLocaleString() : "",
          bodyHtml: safeHtml,
          bodyText: typeof data.body === "string" ? data.body : "",
          attachments,
        });
      } catch (error) {
        setMsgPreviewError(error instanceof Error ? error.message : "تعذرت قراءة مرفقات رسالة Outlook.");
      }
    })();
  }

  async function searchInsideAttachment() {
    if (!activeAttachment) return;
    const term = attachmentSearchQuery.trim();
    if (!term) {
      setAttachmentSearchStatus("اكتب الاسم أو رقم الحجز أولاً.");
      setAttachmentSearchMatches([]);
      return;
    }
    setAttachmentSearchStatus("جارٍ البحث داخل المرفق...");
    setAttachmentSearchMatches([]);
    try {
      const extension = activeAttachment.name.split(".").pop()?.toLowerCase() || "";
      let pages: string[] = [];
      if (extension === "pdf" || activeAttachment.type === "application/pdf") {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
        const pdf = await pdfjs.getDocument({ data: new Uint8Array(await activeAttachment.blob.arrayBuffer()) }).promise;
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
          const page = await pdf.getPage(pageNumber);
          const content = await page.getTextContent();
          pages.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
        }
      } else if (extension === "docx") {
        const mammoth = await import("mammoth/mammoth.browser");
        const result = await mammoth.extractRawText({ arrayBuffer: await activeAttachment.blob.arrayBuffer() });
        pages = [result.value || ""];
      } else if (["txt", "csv", "xml", "html", "htm", "eml", "log"].includes(extension)) {
        pages = [(await activeAttachment.blob.text())];
      } else if (extension === "msg") {
        const attachmentFile = new File([activeAttachment.blob], activeAttachment.name, { type: activeAttachment.type });
        const extracted = await extractText(attachmentFile, "msg");
        pages = extracted.pages;
      } else {
        setAttachmentSearchStatus("البحث النصي غير متاح لهذا النوع من المرفقات. إذا كان الملف صورة أو PDF ممسوحاً ضوئياً، فهو يحتاج إلى OCR.");
        return;
      }
      const normalizedTerm = normalize(term);
      const matches = pages.flatMap((pageText, index) => {
        const normalizedPage = normalize(pageText);
        if (!normalizedPage.includes(normalizedTerm)) return [];
        const rawPosition = pageText.toLocaleLowerCase().indexOf(term.toLocaleLowerCase());
        const excerptStart = rawPosition >= 0 ? Math.max(0, rawPosition - 90) : 0;
        const excerpt = pageText.slice(excerptStart, rawPosition >= 0 ? rawPosition + term.length + 120 : 240).replace(/\s+/g, " ").trim();
        return [{ page: index + 1, excerpt: excerpt || "تم العثور على تطابق في هذه الصفحة." }];
      });
      setAttachmentSearchMatches(matches);
      if (matches.length) {
        setAttachmentPdfSearchTerm(extension === "pdf" || activeAttachment.type === "application/pdf" ? term : "");
        setActiveAttachmentPage(matches[0].page);
        setAttachmentSearchStatus(`تم العثور على ${matches.length} صفحة مطابقة. تم تمرير عبارة البحث إلى عارض PDF لمحاولة تمييزها، مع تكبير العرض.`);
      } else {
        setAttachmentSearchStatus("لم يتم العثور على الاسم أو رقم الحجز داخل نص المرفق. إذا كان المستند ممسوحاً ضوئياً فقد يحتاج إلى OCR.");
      }
    } catch (error) {
      setAttachmentSearchStatus(error instanceof Error ? "تعذر البحث داخل المرفق: " + error.message : "تعذر قراءة المرفق للبحث داخله.");
    }
  }

  function downloadMsgAttachment(attachment: MsgAttachmentPreview) {
    const link = document.createElement("a");
    link.href = attachment.url;
    link.download = attachment.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function downloadOriginalMsg() {
    if (!selected || selected.extension.toLowerCase() !== "msg") return;
    // Download the untouched original MSG file. Outlook on the user's computer
    // can then open and print the authoritative message and its attachments.
    const url = URL.createObjectURL(selected.file);
    const link = document.createElement("a");
    link.href = url;
    link.download = selected.name.toLowerCase().endsWith(".msg") ? selected.name : selected.name + ".msg";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  async function openOriginalMsgInOutlook() {
    if (!selected || selected.extension.toLowerCase() !== "msg") return;
    // In the desktop app, open the original file path through Windows file associations.
    // This allows Outlook (if installed and associated with .msg) to open the real file.
    if (window.desktopBridge && (selected.path.startsWith("\\\\") || /^[a-zA-Z]:[\\/]/.test(selected.path))) {
      try {
        const opened = await window.desktopBridge.openPath(selected.path);
        setStorageMessage(opened
          ? "تم إرسال ملف Outlook الأصلي إلى Windows لفتحه بالتطبيق المرتبط بملفات MSG."
          : "تعذر فتح الملف تلقائياً. تأكد من تثبيت Outlook وارتباط ملفات MSG به، أو استخدم زر تنزيل الملف الأصلي.");
      } catch {
        setStorageMessage("تعذر فتح ملف MSG في Outlook. استخدم زر تنزيل الملف الأصلي.");
      }
      return;
    }
    // Browser fallback: download the untouched message for opening in Outlook.
    downloadOriginalMsg();
    setStorageMessage("تم تنزيل ملف MSG الأصلي. افتحه باستخدام Outlook إذا كان مثبتاً على جهازك.");
  }

  async function removeSavedFolder() {
    if (!window.confirm("هل تريد إلغاء ربط مجلد الحجوزات؟ لن يتم حذف الملفات الأصلية من جهازك.")) return;
    await window.desktopBridge?.unwatchFolder();
    setFiles([]);
    setQuery("");
    setSelected(null);
    setCurrentPage(1);
    setFolderName("");
    setNativeFolderPath("");
    localStorage.removeItem(NATIVE_FOLDER_KEY);
    localStorage.removeItem(GUEST_STATE_KEY);
    setWarnings([]);
    setStorageMessage("تم إلغاء ربط مجلد الحجوزات. الملفات الأصلية لم يتم تغييرها.");
  }

  function printMsgImage(attachment: MsgAttachmentPreview) {
    if (!attachment.type.startsWith("image/")) return;

    // Open a dedicated print page for the selected Outlook image attachment.
    // The popup is created directly from the button click to avoid blockers.
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      window.alert("يرجى السماح بالنوافذ المنبثقة حتى تتمكن من طباعة الصورة.");
      return;
    }

    const safeName = attachment.name.replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[character] || character);
    printWindow.document.open();
    printWindow.document.write(`<!doctype html>
      <html lang="ar">
        <head>
          <meta charset="utf-8">
          <title>${safeName}</title>
          <style>
            @page { margin: 10mm; }
            html, body { margin: 0; padding: 0; background: #fff; }
            body { min-height: 100vh; display: flex; align-items: center; justify-content: center; }
            img { display: block; max-width: 100%; max-height: 96vh; object-fit: contain; }
            @media print { img { max-height: 275mm; } }
          </style>
        </head>
        <body>
          <img src="${attachment.url}" alt="${safeName}">
          <script>
            const image = document.querySelector("img");
            image.addEventListener("load", () => {
              window.focus();
              window.print();
            }, { once: true });
            image.addEventListener("error", () => {
              document.body.textContent = "تعذر تحميل الصورة للطباعة.";
            }, { once: true });
          </script>
        </body>
      </html>`);
    printWindow.document.close();
  }

  function printVoucher() {
    if (!selected) return;
    // Outlook MSG bookings: print the PDF voucher attached to the email,
    // never the email body. Direct PDF bookings: print the selected PDF itself.
    const voucher = selected.extension === "msg"
      ? msgPreview?.attachments.find((attachment) =>
          attachment.type === "application/pdf" || attachment.name.toLowerCase().endsWith(".pdf"))
      : selected.extension === "pdf"
        ? { blob: selected.file }
        : undefined;

    if (!voucher) {
      window.alert(selected.extension === "msg"
        ? "لا يوجد ملف PDF مرفق بهذه الرسالة. لا يمكن طباعة الفاوتشر."
        : "الطباعة متاحة لملفات PDF فقط.");
      return;
    }

    const url = URL.createObjectURL(voucher.blob);
    const printWindow = window.open(url, "_blank");
    if (!printWindow) {
      URL.revokeObjectURL(url);
      window.alert("يرجى السماح بالنوافذ المنبثقة حتى تتمكن من طباعة الفاوتشر.");
      return;
    }
    const timer = window.setInterval(() => {
      try {
        if (printWindow.document.readyState === "complete") {
          window.clearInterval(timer);
          printWindow.focus();
          printWindow.print();
        }
      } catch {
        // The browser's built-in PDF viewer may block document access.
        // It still opens the exact voucher PDF for printing from its toolbar.
        window.clearInterval(timer);
      }
    }, 700);
    window.setTimeout(() => window.clearInterval(timer), 15000);
    window.setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async function copyGuestDetails(person: { name: string; dob: string }) {
    const value = /^\(Age:\s*\d+\)$/i.test(person.dob)
      ? person.name + " " + person.dob
      : [person.name, person.dob === "لم يُعثر عليه" ? "" : person.dob].filter(Boolean).join(" - ");
    try {
      await navigator.clipboard.writeText(value);
      setDiagnosticStatus(`تم نسخ بيانات ${person.name}.`);
    } catch {
      setDiagnosticStatus("تعذر النسخ. تأكد من السماح للمتصفح بالوصول إلى الحافظة.");
    }
  }

  const [diagnosticStatus, setDiagnosticStatus] = useState("");

  async function copyArrivalNumbers(kind: "room" | "confirmation") {
    const values = arrivals
      .map((item) => kind === "room" ? item.roomNo : item.confirmationNo)
      .filter(Boolean);
    if (!values.length) {
      setMultipleCopyStatus("لا توجد بيانات في arr.pdf لنسخها.");
      return;
    }
    try {
      await navigator.clipboard.writeText(values.join(", "));
      setMultipleCopyStatus(kind === "room"
        ? `تم نسخ ${values.length} رقم غرفة. يمكنك لصقها في البحث المتعدد.`
        : `تم نسخ ${values.length} رقم تأكيدي. يمكنك لصقها في البحث المتعدد.`);
    } catch {
      setMultipleCopyStatus("تعذر النسخ. تأكد من السماح للتطبيق بالوصول إلى الحافظة.");
    }
  }

  async function copyPageDiagnostics() {
    if (!selected) return;
    setDiagnosticStatus("جارٍ تجهيز بيانات الصفحة...");
    try {
      let diagnostic: unknown;
      if (selected.extension === "pdf") {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
        const buffer = await selected.file.arrayBuffer();
        const pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
        const page = await pdf.getPage(currentPage);
        const textContent = await page.getTextContent();
        const items = textContent.items.flatMap((item) => {
          if (!("str" in item) || !item.str.trim()) return [];
          const transform = "transform" in item ? item.transform : undefined;
          return [{
            text: item.str,
            x: transform?.[4] ?? null,
            y: transform?.[5] ?? null,
            width: "width" in item ? item.width : null,
            height: "height" in item ? item.height : null,
          }];
        });
        diagnostic = {
          fileName: selected.name,
          company: selected.company,
          page: currentPage,
          pageSize: (() => { const viewport = page.getViewport({ scale: 1 }); return { width: viewport.width, height: viewport.height }; })(),
          extractedText: pageText,
          textItemsWithCoordinates: items,
        };
      } else {
        diagnostic = {
          fileName: selected.name,
          company: selected.company,
          page: currentPage,
          extractedText: pageText,
          note: "هذا الملف ليس PDF؛ لا تتوفر إحداثيات عناصر الصفحة.",
        };
      }
      await navigator.clipboard.writeText(JSON.stringify(diagnostic, null, 2));
      setDiagnosticStatus("تم نسخ بيانات الصفحة. الصقها هنا في المحادثة بعد مراجعتها.");
    } catch (error) {
      setDiagnosticStatus("تعذر النسخ تلقائياً. تأكد من السماح للمتصفح بالوصول إلى الحافظة، ثم حاول مرة أخرى.");
    }
  }

  async function copyAttachmentDiagnostics() {
    if (!activeAttachment || !selected) return;
    setDiagnosticStatus("جارٍ تجهيز بيانات المرفق للتشخيص...");
    try {
      const extension = activeAttachment.name.split(".").pop()?.toLowerCase() || "";
      const diagnostic: Record<string, unknown> = {
        sourceFileName: selected.name,
        company: selected.company,
        attachmentName: activeAttachment.name,
        attachmentType: activeAttachment.type || "application/octet-stream",
        attachmentSize: activeAttachment.size,
      };

      if (extension === "pdf" || activeAttachment.type === "application/pdf") {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
        const pdf = await pdfjs.getDocument({
          data: new Uint8Array(await activeAttachment.blob.arrayBuffer()),
        }).promise;
        const pages = [];
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
          const page = await pdf.getPage(pageNumber);
          const textContent = await page.getTextContent();
          const items = textContent.items.flatMap((item) => {
            if (!("str" in item) || !item.str.trim()) return [];
            const transform = "transform" in item ? item.transform : undefined;
            return [{
              text: item.str,
              x: transform?.[4] ?? null,
              y: transform?.[5] ?? null,
              width: "width" in item ? item.width : null,
              height: "height" in item ? item.height : null,
            }];
          });
          const viewport = page.getViewport({ scale: 1 });
          pages.push({
            page: pageNumber,
            pageSize: { width: viewport.width, height: viewport.height },
            extractedText: textContent.items.map((item) => ("str" in item ? item.str : "")).join(" "),
            textItemsWithCoordinates: items,
          });
        }
        diagnostic.pageCount = pdf.numPages;
        diagnostic.pages = pages;
      } else if (extension === "docx") {
        const mammoth = await import("mammoth/mammoth.browser");
        const result = await mammoth.extractRawText({
          arrayBuffer: await activeAttachment.blob.arrayBuffer(),
        });
        diagnostic.extractedText = result.value || "";
        diagnostic.pages = [{ page: 1, extractedText: result.value || "" }];
      } else if (["txt", "csv", "xml", "html", "htm", "eml", "log"].includes(extension)) {
        const extractedText = await activeAttachment.blob.text();
        diagnostic.extractedText = extractedText;
        diagnostic.pages = [{ page: 1, extractedText }];
      } else {
        diagnostic.note = "لا تتوفر حالياً قراءة نصية لهذا النوع من المرفقات؛ تم تضمين بيانات الملف الأساسية فقط. قد يحتاج الملف المصور إلى OCR.";
      }

      await navigator.clipboard.writeText(JSON.stringify(diagnostic, null, 2));
      setDiagnosticStatus("تم نسخ بيانات المرفق للتشخيص. الصقها هنا في المحادثة بعد مراجعتها.");
    } catch (error) {
      setDiagnosticStatus(error instanceof Error
        ? "تعذر تجهيز بيانات المرفق: " + error.message
        : "تعذر نسخ بيانات المرفق. تأكد من السماح للمتصفح بالوصول إلى الحافظة.");
    }
  }

  function formatSize(bytes: number) {
    return bytes < 1024 * 1024 ? (bytes / 1024).toFixed(1) + " KB" : (bytes / (1024 * 1024)).toFixed(2) + " MB";
  }

  return (
    <div className="page" dir="rtl">
      <header className="hero">
        <p className="eyebrow">Long Beach Resort · Hotel Tools</p>
        <h1>Guest Name Extractor</h1>
        <p>ابحث عن ملف الحجز برقم الحجز أو الرقم التأكيدي أو اسم النزيل أو الشركة، واستخرج أسماء جميع النزلاء وتواريخ ميلادهم تلقائياً.</p>
      </header>
      <section className="panel">
        <div className="section-heading">
          <div><h2>1. اختيار مجلد الحجوزات بالكامل</h2>
            <p className="muted">اربط مجلد الحجوزات الأصلي مرة واحدة. في نسخة Windows تتم قراءة الملفات مباشرة من مكانها دون رفعها أو نسخها إلى ذاكرة المتصفح.</p></div>
          <button type="button" className="add-button" onClick={() => void chooseNativeFolder()} disabled={busy}>
            {busy ? "جارٍ فحص المجلد..." : isDesktop ? (nativeFolderPath ? "تغيير مجلد الحجوزات" : "ربط مجلد Windows") : "اختيار مجلد"}
          </button>
          {isDesktop && nativeFolderPath && <button type="button" className="add-button" onClick={() => void scanNativeFolder(nativeFolderPath)} disabled={busy}>فحص التحديثات</button>}
          {files.length > 0 && <button type="button" className="add-button" onClick={() => void removeSavedFolder()} disabled={busy}>إلغاء ربط المجلد</button>}
          <button type="button" className="add-button" onClick={() => arrivalInputRef.current?.click()} disabled={arrivalBusy}>
            {arrivalBusy ? "جارٍ قراءة التقرير..." : arrivals.length ? "استبدال تقرير arr.pdf" : "رفع تقرير arr.pdf"}
          </button>
          {arrivals.length > 0 && <button type="button" className="add-button" onClick={clearArrivalReport} disabled={arrivalBusy}>حذف تقرير الوصول</button>}
          <input ref={arrivalInputRef} type="file" accept=".pdf,application/pdf" hidden
            onChange={(event) => { void uploadArrivalReport(event.currentTarget.files); event.currentTarget.value = ""; }} />
          <input ref={inputRef} type="file" multiple hidden
            {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
            onChange={(event) => { void scanFolder(event.currentTarget.files); event.currentTarget.value = ""; }} />
        </div>
        {folderName && <div className="filename" dir="ltr">المجلد المرتبط: {folderName}</div>}
        <p className="saved-hint" role="status">{storageMessage}</p>
        {arrivalReportName && <div className="filename">تقرير الوصول: {arrivalReportName} · {arrivals.length.toLocaleString("en-US")} حجز</div>}
        {arrivals.length > 0 && <div className="filename">بيانات الوصول المحفوظة: {arrivals.length.toLocaleString("en-US")} حجز</div>}
        {arrivalStatus && <p className="saved-hint" role="status">{arrivalStatus}</p>}
        {busy && <div className="folder-progress" role="status">
          <div className="progress-track"><span style={{ width: progress.total ? (progress.done / progress.total * 100) + "%" : "0%" }} /></div>
          <p className="saved-hint">جارٍ فحص الملفات: {progress.done} من {progress.total}</p>
        </div>}
        {error && <div className="notice error">{error}</div>}
        {warnings.length > 0 && <div className="notice">تعذرت قراءة {warnings.length} ملف، وتم استكمال فحص بقية الملفات.</div>}
      </section>

      {files.length > 0 && <>
        <section className="panel">
          <div className="section-heading" style={{ marginBottom: 12 }}>
            <h2 style={{ margin: 0 }}>وضع العرض</h2>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" className="add-button" aria-pressed={viewMode === "single"} onClick={() => setViewMode("single")}
                style={viewMode === "single" ? { background: "#1769aa", color: "#fff" } : undefined}>Single View</button>
              <button type="button" className="add-button" aria-pressed={viewMode === "multiple"} onClick={() => setViewMode("multiple")}
                style={viewMode === "multiple" ? { background: "#1769aa", color: "#fff" } : undefined}>Multiple View</button>
            </div>
          </div>
          <h2>فلتر مواعيد الوصول من / إلى</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 10 }}>
            <label style={{ display: "grid", gap: 5 }}>الشركة
              <select value={arrivalCompanyFilter} onChange={(event) => setArrivalCompanyFilter(event.target.value)}
                style={{ minHeight: 40, border: "1px solid #cbd6e2", borderRadius: 8, padding: 8, font: "inherit" }}>
                <option value="all">كل الشركات</option>
                {arrivalCompanyOptions.map((company) => <option key={company} value={company}>{company}</option>)}
              </select>
            </label>
            <label style={{ display: "grid", gap: 5 }}>من
              <input type="time" value={arrivalFrom} onChange={(event) => setArrivalFrom(event.target.value)}
                style={{ minHeight: 40, border: "1px solid #cbd6e2", borderRadius: 8, padding: 8 }} />
            </label>
            <label style={{ display: "grid", gap: 5 }}>إلى
              <input type="time" value={arrivalTo} onChange={(event) => setArrivalTo(event.target.value)}
                style={{ minHeight: 40, border: "1px solid #cbd6e2", borderRadius: 8, padding: 8 }} />
            </label>
          </div>
          {(arrivalFrom || arrivalTo || arrivalCompanyFilter !== "all") && <div style={{ marginTop: 8, fontSize: 12, color: "#64748b" }}>
            الغرف المطابقة ({arrivalTimeMatches.length}): {arrivalTimeMatches.length
              ? arrivalTimeMatches.map((item) => item.roomNo + " (" + item.arrivalTime + ")").join("، ")
              : "لا توجد غرف مطابقة للفترة والشركة المحددتين"}
          </div>}
        </section>
        {viewMode === "multiple" && <section className="panel">
          <h2>البحث المتعدد</h2>
          <p className="muted">اكتب أرقام الغرف أو الأرقام التأكيدية أو أسماء النزلاء، وافصل بينها بفاصلة.</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "10px 0" }}>
            <button type="button" className="add-button" onClick={() => void copyArrivalNumbers("room")} disabled={!arrivals.length}>نسخ كل أرقام الغرف</button>
            <button type="button" className="add-button" onClick={() => void copyArrivalNumbers("confirmation")} disabled={!arrivals.length}>نسخ كل الأرقام التأكيدية</button>
          </div>
          {multipleCopyStatus && <p className="saved-hint" role="status">{multipleCopyStatus}</p>}
          <textarea value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder="مثال: 0115, 209682, Fazliji, 0166" aria-label="البحث في عدة غرف وحجوزات"
            rows={3} style={{ width: "100%", border: "1px solid #cbd6e2", borderRadius: 10, padding: 12, font: "inherit", resize: "vertical" }} />
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10, marginTop: 10 }}>
            <label htmlFor="multiple-sort" style={{ fontSize: 13, color: "#526174" }}>ترتيب الغرف:</label>
            <select id="multiple-sort" value={multipleSort} onChange={(event) => setMultipleSort(event.target.value as "input" | "company" | "room")}
              style={{ minHeight: 38, border: "1px solid #cbd6e2", borderRadius: 8, padding: "4px 10px", font: "inherit" }}>
              <option value="input">حسب ترتيب البحث</option>
              <option value="company">حسب الشركة ثم رقم الغرفة</option>
              <option value="room">حسب رقم الغرفة</option>
            </select>
          </div>
          {query.trim() && <p className="saved-hint">عدد مربعات البحث: {multipleCards.length}</p>}
          {multipleCards.length > 0 && <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,390px),1fr))", gap: 12, marginTop: 14 }}>
            {multipleCards.map((card) => {
              const isGreen = greenCards.includes(card.key);
              return <article key={card.key} className="folder-result" style={{
                minWidth: 0, background: isGreen ? "#e8f5e9" : undefined,
                border: isGreen ? "1px solid #81c784" : undefined
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <strong>{card.arrival?.name || card.file?.name || card.term}</strong>
                  <button type="button" className="add-button" onClick={() => setGreenCards((current) =>
                    current.includes(card.key) ? current.filter((key) => key !== card.key) : [...current, card.key]
                  )}>{isGreen ? "اللون الافتراضي" : "تمييز بالأخضر"}</button>
                </div>
                {card.arrival
                  ? <p className="muted">رقم الغرفة: {card.arrival.roomNo} · الرقم التأكيدي: {card.arrival.confirmationNo} · موعد الوصول: {card.arrival.arrivalTime}</p>
                  : <p className="muted">بحث: {card.term} · لم يتم العثور على سجل مطابق في arr.pdf</p>}
                {card.file ? <>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "8px 0" }}>
                    {isDesktop && <button type="button" className="add-button" onClick={() => void window.desktopBridge?.showInFolder(card.file!.path)}>مكان الملف</button>}
                    <button type="button" className="add-button" onClick={() => openPreview({ ...card.file!, matchedPages: [1] })}>معاينة واستخراج</button>
                  </div>
                  <p className="folder-path" dir="ltr">{card.file.path}</p>
                  <div style={{ marginTop: 10, padding: 10, borderRadius: 8, background: "rgba(255,255,255,.72)", border: "1px solid #dbe4ef" }}>
                    <strong style={{ display: "block", marginBottom: 7 }}>الأسماء المستخرجة تلقائياً: {card.people.length}</strong>
                    {card.people.length
                      ? <div dir="ltr" style={{ display: "grid", gap: 5, textAlign: "left" }}>
                          {card.people.map((person, personIndex) => <span key={person.name + personIndex} style={{ fontSize: 13 }}>{person.name}{/^\(Age:\s*\d+\)$/i.test(person.dob) ? " " + person.dob : person.dob ? " - " + person.dob : isSunInternationalIndexedFile(card.file) ? " -" : ""}</span>)}
                        </div>
                      : <span className="muted">لم يتم استخراج أسماء من الملف تلقائياً.</span>}
                  </div>
                </> : <p className="empty-exclusions">لم يتم العثور على ملف حجز مطابق لهذا البحث.</p>}
              </article>;
            })}
          </div>}
        </section>}
        {viewMode === "single" && <>
        <section className="panel">
          <h2>2. البحث بالاسم أو الشركة أو رقم الحجز أو رقم الغرفة أو الرقم التأكيدي</h2>
          <p className="muted">بعد رفع تقرير arr.pdf يمكنك البحث برقم الغرفة أو الرقم التأكيدي؛ سيظهر اسم النزيل وميعاد وصوله والملفات التي تحتوي على اسمه.</p>
          <input value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder="اكتب الاسم أو الشركة أو رقم الحجز أو رقم الغرفة أو الرقم التأكيدي..." aria-label="البحث بالاسم أو الشركة أو رقم الحجز أو رقم الغرفة أو الرقم التأكيدي"
            style={{ width: "100%", minHeight: 50, border: "1px solid #cbd6e2", borderRadius: 10, padding: "10px 14px", font: "inherit" }} />
          <div className="folder-stats">
            <div><strong>{files.length}</strong><span>ملف تمت قراءته</span></div>
            <div><strong>{companies}</strong><span>شركة/مجلد شركة</span></div>
            <div><strong>{formatSize(totalSize)}</strong><span>إجمالي حجم الملفات</span></div>
          </div>
          {query.trim() && <p className="saved-hint">عدد الملفات المطابقة: {results.length} · حجوزات تقرير الوصول المطابقة: {arrivalMatches.length}</p>}
          {query.trim() && arrivalMatches.length > 0 && <div className="folder-results" style={{ marginTop: 14 }}>
            {arrivalMatches.map((item) => <article className="folder-result" key={item.confirmationNo}>
              <strong>{item.name}</strong>
              <p className="muted">رقم الغرفة: {item.roomNo} · الرقم التأكيدي: {item.confirmationNo} · موعد الوصول: {item.arrivalTime}</p>
            </article>)}
          </div>}
        </section>
        {query.trim() && <section className="panel">
          <h2>3. نتائج البحث</h2>
          {results.length ? <div className="folder-results">{results.map((item) => (
            <article className="folder-result" key={item.id + item.matchedPages.join(",")}>
              <div className="folder-result-top"><div>
                <strong>{item.name}</strong>
                <p className="muted">الشركة: {item.company}{item.month ? ` · الشهر: ${item.month}` : ""}{item.day ? ` · اليوم: ${item.day}` : ""} · النوع: {item.extension.toUpperCase()} · الحجم: {formatSize(item.size)}</p>
                <p className="muted">الصفحات المطابقة: {item.matchedPages.join(", ")}</p>
              </div><div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {isDesktop && <button type="button" className="add-button" onClick={() => void window.desktopBridge?.showInFolder(item.path)}>مكان الملف</button>}
                <button type="button" className="add-button" onClick={() => openPreview(item)}>معاينة واستخراج</button>
              </div></div>
              <p className="folder-path" dir="ltr">{item.path}</p>
              {(() => {
                // Preview extracted guests for every company using the same
                // company-specific parser used by the document preview.
                const guests = extractPeopleFromIndexedFile(item, effectivePeopleQuery);
                const uniqueGuests = isW2mIndexedFile(item) || isSunInternationalIndexedFile(item)
                  ? guests
                  : guests.filter((person, index, all) =>
                      all.findIndex((candidate) =>
                        normalize(candidate.name) === normalize(person.name)
                        && normalize(candidate.dob) === normalize(person.dob),
                      ) === index,
                    );
                if (!uniqueGuests.length) return null;
                return (
                  <div style={{ marginTop: 10, padding: 10, borderRadius: 8, background: "#f5f8fc", border: "1px solid #dbe4ef" }}>
                    <strong style={{ display: "block", marginBottom: 7 }}>الأسماء المستخرجة تلقائياً: {uniqueGuests.length}</strong>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "5px 12px" }} dir="ltr">
                      {uniqueGuests.map((person, index) => (
                        <span key={index} style={{ fontSize: 13, textAlign: "left" }}>{person.name}{/^\(Age:\s*\d+\)$/i.test(person.dob) ? " " + person.dob : person.dob ? " - " + person.dob : ""}</span>
                      ))}
                    </div>
                  </div>
                );
              })()}
            </article>
          ))}</div> : <p className="empty-exclusions">لا توجد ملفات تحتوي على كلمة البحث.</p>}
        </section>}
        </>}
      </>}

      {selected && <section className="panel" aria-label="الأسماء وتواريخ الميلاد في الصفحة الحالية">
        <div style={{ marginTop: 18 }}>
          <h3>الأسماء وتواريخ الميلاد في الصفحة الحالية</h3>
          {extractedPeople.length ? <div className="folder-results">{extractedPeople.map((person, index) => (
            <div className="folder-result" key={index} dir="ltr" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, textAlign: "left", fontWeight: 700 }}>
              <span>{selected.company.toLocaleLowerCase() === "easy jet" || !person.dob || person.dob === "لم يُعثر عليه" ? person.name : /^\(Age:\s*\d+\)$/i.test(person.dob) || selected.company.toLocaleLowerCase() === "pegas" ? (person.name + " " + person.dob) : (person.name + " - " + person.dob)}</span>
              <button type="button" onClick={() => void copyGuestDetails(person)} title={`نسخ بيانات ${person.name}`} aria-label={`نسخ بيانات ${person.name}`} style={{ flex: "0 0 34px", width: 34, height: 34, display: "inline-flex", alignItems: "center", justifyContent: "center", border: "1px solid #e45b65", borderRadius: 7, background: "#fff", color: "#d93645", cursor: "pointer" }}>
                <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h3"/></svg>
              </button>
            </div>
          ))}</div> : <p className="empty-exclusions">لم يتم العثور على اسم وتاريخ ميلاد بصيغة معروفة في نص هذه الصفحة. قد يحتاج المستند إلى مراجعة يدوية أو OCR إذا كان ممسوحاً ضوئياً.</p>}
          <p className="saved-hint">يتم استخراج البيانات من النص الموجود في الصفحة المحددة فقط. راجع النتيجة قبل اعتمادها.</p>
        </div>
      </section>}

      {selected && <section className="panel" aria-label="معاينة المستند">
        <div className="section-heading">
          <div><h2>4. معاينة المستند واستخراج البيانات</h2>
            <p className="muted">{selected.name} · {selected.company}</p></div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {selected.extension === "msg" ? <>
              <button type="button" className="add-button" onClick={openOriginalMsgInOutlook}>فتح في Outlook</button>
              <button type="button" className="add-button" onClick={downloadOriginalMsg}>تنزيل الملف الأصلي</button>
              <button type="button" className="add-button" onClick={printVoucher} disabled={!msgPreview?.attachments.some((attachment) => attachment.type === "application/pdf" || attachment.name.toLowerCase().endsWith(".pdf"))}>طباعة الفاوتشر</button>
            </> : selected.extension === "pdf" ? <button type="button" className="add-button" onClick={printVoucher}>طباعة الفاوتشر</button> : null}
            <button type="button" className="add-button" onClick={() => void copyPageDiagnostics()}>نسخ بيانات الصفحة للتشخيص</button>
            <button type="button" className="add-button" onClick={() => setSelected(null)}>إغلاق المعاينة</button>
          </div>
        </div>
        {selected.extension === "pdf" && <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "12px 0" }}>
          <label htmlFor="pdf-page">الصفحة الحالية:</label>
          <select id="pdf-page" value={currentPage} onChange={(event) => setCurrentPage(Number(event.target.value))}
            style={{ minHeight: 38, border: "1px solid #cbd6e2", borderRadius: 8, padding: "4px 10px" }}>
            {selected.pages.map((_page, index) => <option key={index} value={index + 1}>صفحة {index + 1}</option>)}
          </select>
          <span className="muted">من {selected.pages.length}</span>
        </div>}
        {selected.extension === "msg" ? (
          <div style={{ border: "1px solid #c8d2df", borderRadius: 8, overflow: "hidden", background: "#fff", color: "#253247", direction: "ltr", textAlign: "left" }}>
            {msgPreviewError && <div role="alert" style={{ padding: 14, color: "#a12622", background: "#fff1f0" }}>{msgPreviewError}</div>}
            {!msgPreview && !msgPreviewError && <p style={{ padding: 22 }}>جارٍ قراءة رسالة Outlook ومرفقاتها...</p>}
            {msgPreview && <>
              <div style={{ background: "#f2f5f9", borderBottom: "1px solid #d5dce5", padding: "18px 22px" }}>
                <h3 style={{ margin: "0 0 14px", color: "#1d2c42" }}>{msgPreview.subject}</h3>
                {[["From", msgPreview.sender + (msgPreview.senderEmail && msgPreview.senderEmail !== msgPreview.sender ? " <" + msgPreview.senderEmail + ">" : "")], ["To", msgPreview.to], ["Cc", msgPreview.cc], ["Sent", msgPreview.sent]].filter((row) => row[1]).map(([label, value]) => (
                  <div key={label} style={{ display: "flex", gap: 12, padding: "3px 0", fontSize: 13 }}><strong style={{ width: 48, color: "#64748b" }}>{label}:</strong><span>{value}</span></div>
                ))}
              </div>
              {msgPreview.attachments.length > 0 ? <div style={{ padding: "12px 18px", borderBottom: "1px solid #e0e5eb", background: "#fafbfd" }}>
                <strong style={{ display: "block", marginBottom: 9 }}>المرفقات ({msgPreview.attachments.length})</strong>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {msgPreview.attachments.map((attachment, index) => (
                    <div key={index} style={{ border: "1px solid #d6dee8", borderRadius: 7, padding: 9, minWidth: 190, maxWidth: 280, background: "white" }}>
                      {attachment.type.startsWith("image/") ? (
                        <button type="button" onClick={() => { setActiveAttachment(attachment); setAttachmentSearchQuery(""); setAttachmentSearchMatches([]); setAttachmentSearchStatus(""); setActiveAttachmentPage(1); setAttachmentPdfSearchTerm(""); }}
                          aria-label={`معاينة الصورة ${attachment.name}`}
                          style={{ display: "block", width: "100%", padding: 0, marginBottom: 9, border: "1px solid #e2e8f0", borderRadius: 6, background: "#f8fafc", cursor: "zoom-in", overflow: "hidden" }}>
                          <img src={attachment.url} alt={attachment.name} loading="lazy"
                            style={{ display: "block", width: "100%", height: 150, objectFit: "contain" }} />
                        </button>
                      ) : null}
                      <div style={{ fontSize: 12, overflowWrap: "anywhere", marginBottom: 8 }}>📎 {attachment.name}<div style={{ color: "#778399", marginTop: 3 }}>{formatSize(attachment.size)}</div></div>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <button type="button" className="add-button" onClick={() => { setActiveAttachment(attachment); setAttachmentSearchQuery(""); setAttachmentSearchMatches([]); setAttachmentSearchStatus(""); setActiveAttachmentPage(1); setAttachmentPdfSearchTerm(""); }}>{attachment.type.startsWith("image/") ? "تكبير الصورة" : "فتح / عرض"}</button>
                        {attachment.type.startsWith("image/") && <button type="button" className="add-button" onClick={() => printMsgImage(attachment)}>طباعة الصورة</button>}
                        <button type="button" className="add-button" onClick={() => downloadMsgAttachment(attachment)}>تنزيل</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div> : <p style={{ padding: "12px 18px", margin: 0, color: "#64748b" }}>لا تحتوي الرسالة على مرفقات.</p>}
              {activeAttachment && <div style={{ padding: 14, borderBottom: "1px solid #d5dce5", background: "#f4f7fb" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 10 }}>
                  <strong>{activeAttachment.name}</strong>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button type="button" className="add-button" onClick={() => void copyAttachmentDiagnostics()}>نسخ بيانات المرفق للتشخيص</button>
                    <button type="button" className="add-button" onClick={() => { setActiveAttachment(null); setAttachmentSearchMatches([]); setAttachmentSearchStatus(""); setAttachmentPdfSearchTerm(""); }}>إغلاق المرفق</button>
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 8, marginBottom: 12, direction: "rtl" }}>
                  <input value={attachmentSearchQuery} onChange={(event) => setAttachmentSearchQuery(event.target.value)}
                    onKeyDown={(event) => { if (event.key === "Enter") void searchInsideAttachment(); }}
                    placeholder="ابحث داخل المرفق بالاسم أو رقم الحجز..."
                    aria-label="البحث داخل المرفق بالاسم أو رقم الحجز"
                    style={{ width: "100%", minHeight: 42, border: "1px solid #cbd6e2", borderRadius: 8, padding: "8px 12px", font: "inherit" }} />
                  <button type="button" className="add-button" onClick={() => void searchInsideAttachment()}>بحث داخل المرفق</button>
                </div>
                {attachmentSearchStatus && <p role="status" style={{ margin: "0 0 10px", color: "#526174", direction: "rtl" }}>{attachmentSearchStatus}</p>}
                {attachmentSearchMatches.length > 0 && <div style={{ display: "grid", gap: 7, marginBottom: 12, direction: "rtl" }}>
                  {attachmentSearchMatches.map((match) => (
                    <button key={match.page} type="button" className="add-button" onClick={() => setActiveAttachmentPage(match.page)}
                      style={{ textAlign: "right", whiteSpace: "normal" }}>
                      صفحة {match.page}: {match.excerpt}
                    </button>
                  ))}
                </div>}
                {activeAttachment.type.startsWith("image/") ? <img src={activeAttachment.url} alt={activeAttachment.name} style={{ maxWidth: "100%", maxHeight: 560, objectFit: "contain" }} /> :
                  activeAttachment.type === "application/pdf" ? <iframe title={activeAttachment.name} src={activeAttachment.url + "#page=" + activeAttachmentPage + "&toolbar=1&zoom=150" + (attachmentPdfSearchTerm ? "&search=" + encodeURIComponent(attachmentPdfSearchTerm) : "")} style={{ width: "100%", height: 600, border: 0, background: "white" }} /> :
                  activeAttachment.type.startsWith("text/") ? <iframe title={activeAttachment.name} src={activeAttachment.url} style={{ width: "100%", height: 400, border: 0, background: "white" }} /> :
                  <p>لا تتوفر معاينة داخلية لهذا النوع من الملفات. يمكنك تنزيله وفتحه بالبرنامج المناسب.</p>}
              </div>}
              <div style={{ padding: 22, minHeight: 180, fontFamily: "Arial,sans-serif", fontSize: 14, lineHeight: 1.55, overflowWrap: "anywhere" }}>
                {msgPreview.bodyHtml ? <iframe title="محتوى رسالة Outlook" sandbox="" srcDoc={msgPreview.bodyHtml} style={{ width: "100%", minHeight: 360, border: 0, background: "white" }} /> :
                  <pre style={{ whiteSpace: "pre-wrap", font: "inherit", margin: 0 }}>{msgPreview.bodyText || "لا يوجد محتوى نصي في الرسالة."}</pre>}
              </div>
            </>}
          </div>
        ) : (
          // Non-Outlook files use the regular PDF/text preview.
          <div style={{ border: "1px solid #d7dee8", borderRadius: 10, overflow: "hidden", background: "#f3f5f7" }}>
            {selected.extension === "pdf" ? <iframe title="معاينة ملف PDF" src={previewUrl + "#page=" + currentPage + "&toolbar=1"}
              style={{ width: "100%", height: "75vh", maxHeight: 850, minHeight: 560, border: 0 }} /> :
              ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff"].includes(selected.extension) ? (
                <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: 420, maxHeight: "75vh", overflow: "auto", padding: 16, background: "#e9edf2" }}>
                  <img src={previewUrl} alt={selected.name} style={{ display: "block", maxWidth: "100%", maxHeight: "72vh", objectFit: "contain", background: "white", boxShadow: "0 2px 12px rgba(0,0,0,.12)" }} />
                </div>
              ) : <pre style={{ whiteSpace: "pre-wrap", overflow: "auto", maxHeight: 600, padding: 18, direction: "rtl", background: "white" }}>{pageText || "لا يوجد نص قابل للعرض."}</pre>}
          </div>
        )}
          {diagnosticStatus && <p className="saved-hint" role="status">{diagnosticStatus}</p>}
          <p className="saved-hint">تنبيه: قد تتضمن البيانات المنسوخة أسماء النزلاء وأرقام جوازات السفر؛ راجعها واحذف أي بيانات لا ترغب في مشاركتها قبل إرسالها.</p>
      </section>}

      {warnings.length > 0 && <section className="panel"><h2>ملفات تعذرت قراءتها</h2>
        <ul className="steps">{warnings.map((path) => <li key={path} dir="ltr">{path}</li>)}</ul></section>}
      <p className="foot"><a href="/" style={{ color: "#1769aa" }}>العودة إلى أدوات الفندق</a></p>
    </div>
  );
}