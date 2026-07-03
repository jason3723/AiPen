/**
 * ProseMirror JSON → Word (.docx) 导出
 *
 * 遍历 ProseMirror JSON 文档节点，原生构建 docx.js 对象。
 */

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Footer,
  PageNumber,
  AlignmentType,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  ImageRun,
  WidthType,
  BorderStyle,
  VerticalAlign,
  convertMillimetersToTwip,
} from "docx";
import type { ISpacingProperties } from "docx";
import JSZip from "jszip";
import { invoke } from "@tauri-apps/api/core";
import { save, message, ask } from "@tauri-apps/plugin-dialog";


// ── 默认排版设置 ──────────────────────────────────────────
export interface ExportSettings {
  fontH1: string;
  fontH2: string;
  fontH3: string;
  fontH4: string;
  fontBody: string;
  sizeH1: number;
  sizeH2: number;
  sizeH3: number;
  sizeH4: number;
  sizeBody: number;
  boldH1: boolean;
  boldH2: boolean;
  boldH3: boolean;
  boldH4: boolean;
  boldBody: boolean;
  marginTop: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
  charsPerLine: number;
  linesPerPage: number;
  lineSpacingPt: number;
  headerMargin: number;
  footerMargin: number;
  cellMarginTop: number;
  cellMarginBottom: number;
  cellMarginLeft: number;
  cellMarginRight: number;
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  fontH1: "方正小标宋简体",
  fontH2: "方正黑体简体",
  fontH3: "方正楷体简体",
  fontH4: "方正楷体简体",
  fontBody: "方正仿宋简体",
  sizeH1: 22,
  sizeH2: 16,
  sizeH3: 16,
  sizeH4: 16,
  sizeBody: 16,
  boldH1: true,
  boldH2: true,
  boldH3: true,
  boldH4: true,
  boldBody: false,
  marginTop: 37,
  marginBottom: 35,
  marginLeft: 28,
  marginRight: 26,
  charsPerLine: 28,
  linesPerPage: 22,
  lineSpacingPt: 28,
  headerMargin: 15,
  footerMargin: 26,
  cellMarginTop: 1.5,
  cellMarginBottom: 1.5,
  cellMarginLeft: 1.5,
  cellMarginRight: 1.5,
};

function ptToHalfPt(pt: number): number { return pt * 2; }
function ptToTwip(pt: number): number { return pt * 20; }

// ── ProseMirror 节点类型 ─────────────────────────────────
interface PMNode {
  type: string;
  text?: string;
  content?: PMNode[];
  attrs?: Record<string, any>;
  marks?: PMMark[];
}

interface PMMark {
  type: string;
  attrs?: Record<string, any>;
}

// ── 解析 ProseMirror JSON ─────────────────────────────────
function parseContent(raw: string): PMNode | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.type === 'doc') {
      return parsed as PMNode;
    }
  } catch { /* 非 JSON */ }
  // 回退：旧版纯文本 → 包裹为 ProseMirror doc
  return raw
    ? { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: raw }] }] }
    : { type: "doc", content: [] };
}

// ── 内联文本解析（应用 marks → TextRun） ─────────────────
function buildTextRuns(node: PMNode, settings: ExportSettings, defaultFont: string, defaultSize: number): TextRun[] {
  // 文本节点
  if (node.type === 'text') {
    let bold = false;
    let italic = false;
    let underline = false;
    let strike = false;
    let code = false;
    let color: string | undefined;
    let fontFamily: string | undefined;
    let fontSize: number | undefined;
    let href: string | undefined;

    let superscript = false;
    let subscript = false;

    if (node.marks) {
      for (const m of node.marks) {
        switch (m.type) {
          case 'bold': bold = true; break;
          case 'italic': italic = true; break;
          case 'underline': underline = true; break;
          case 'strike': strike = true; break;
          case 'code': code = true; break;
          case 'superscript': superscript = true; break;
          case 'subscript': subscript = true; break;
          case 'link': href = m.attrs?.href; break;
          case 'textStyle':
            if (m.attrs?.color) color = m.attrs.color;
            if (m.attrs?.fontSize) fontSize = parseFontSize(m.attrs.fontSize);
            if (m.attrs?.fontFamily) fontFamily = m.attrs.fontFamily;
            break;
          case 'highlight': break; // Word 不支持高亮，忽略
        }
      }
    }

    return [new TextRun({
      text: node.text || '',
      font: code ? 'Consolas' : (fontFamily || defaultFont),
      size: ptToHalfPt(fontSize || defaultSize),
      bold,
      italics: italic,
      underline: underline ? { type: 'single' } : undefined,
      strike,
      color: color || undefined,
      superScript: superscript || undefined,
      subScript: subscript || undefined,
      ...(href ? { style: 'Hyperlink' } : {}), // 简化：Word 链接需要单独处理
    })];
  }

  // 容器节点（如 paragraph heading 等）→ 递归
  if (node.content) {
    const runs: TextRun[] = [];
    for (const child of node.content) {
      runs.push(...buildTextRuns(child, settings, defaultFont, defaultSize));
    }
    return runs;
  }

  return [];
}

function parseFontSize(val: string | undefined): number | undefined {
  if (!val) return undefined;
  const num = parseFloat(val);
  return isNaN(num) ? undefined : num;
}

/** 将 JSON 中的 CSS textIndent（如 "2em"）转换为 twip 值 */
function parseTextIndentTwip(textIndent: string | undefined, fontSizePt: number): number | undefined {
  if (!textIndent) return undefined;
  const match = textIndent.match(/^([\d.]+)em$/);
  if (!match) return undefined;
  return parseFloat(match[1]) * fontSizePt * 20;
}

/** 将 JSON 中的 CSS lineHeight（如 "1.5"）转换为 docx spacing 对象 */
function parseLineHeightSpacing(lineHeight: string | undefined, defaultSpacing: ISpacingProperties): ISpacingProperties {
  if (!lineHeight) return defaultSpacing;
  const num = parseFloat(lineHeight);
  if (isNaN(num) || num <= 0) return defaultSpacing;
  return { line: Math.round(num * 240), lineRule: "auto", before: 0, after: 0 };
}

// ── 遍历 ProseMirror 节点构建 docx 元素 ─────────────────
async function buildDocx(doc: PMNode | null, settings: ExportSettings): Promise<Document> {
  if (!doc || doc.type !== 'doc') {
    return new Document({ sections: [{ properties: {}, children: [] }] });
  }

  const lineSpacingTwip = ptToTwip(settings.lineSpacingPt);
  const contentW = 210 - settings.marginLeft - settings.marginRight;
  const contentH = 297 - settings.marginTop - settings.marginBottom;
  const contentWidthPt = convertMillimetersToTwip(contentW) / 20;
  const charSpace = Math.floor(
    (contentWidthPt / settings.charsPerLine - settings.sizeBody) * 4096,
  );
  const linePitch = Math.floor(convertMillimetersToTwip(contentH) / settings.linesPerPage);
  const bodyWidthTwip = convertMillimetersToTwip(contentW);

  const bodySpacing: ISpacingProperties = {
    line: lineSpacingTwip,
    lineRule: "exact",
    before: 0,
    after: 0,
  };

  const tblBorder = { style: BorderStyle.SINGLE, size: 1, color: "000000" };
  const children: (Paragraph | Table)[] = [];

  for (const node of doc.content || []) {
    await appendNode(node, children, settings, bodySpacing, bodyWidthTwip, tblBorder);
  }

  return new Document({
    styles: {
      default: {
        document: {
          run: {
            font: { ascii: settings.fontBody, eastAsia: settings.fontBody, hAnsi: settings.fontBody, cs: settings.fontBody },
            size: ptToHalfPt(16),
          },
          paragraph: { indent: { firstLine: 0 } },
        },
        heading1: {
          run: { font: settings.fontH1, size: ptToHalfPt(settings.sizeH1), color: "000000" },
          paragraph: { alignment: AlignmentType.CENTER, indent: { firstLine: 0 }, spacing: { line: ptToTwip(32), lineRule: "exact" } },
        },
        heading2: {
          run: { font: settings.fontH2, size: ptToHalfPt(settings.sizeH2), color: "000000" },
          paragraph: { indent: { firstLine: 0 } },
        },
        heading3: {
          run: { font: settings.fontH3, size: ptToHalfPt(settings.sizeH3), color: "000000" },
          paragraph: { indent: { firstLine: 0 } },
        },
        heading4: {
          run: { font: settings.fontH4, size: ptToHalfPt(settings.sizeH4), color: "000000" },
          paragraph: { indent: { firstLine: 0 } },
        },
      },
    },
    sections: [{
      properties: {
        page: {
          margin: {
            top: convertMillimetersToTwip(settings.marginTop),
            bottom: convertMillimetersToTwip(settings.marginBottom),
            left: convertMillimetersToTwip(settings.marginLeft),
            right: convertMillimetersToTwip(settings.marginRight),
            header: convertMillimetersToTwip(settings.headerMargin),
            footer: convertMillimetersToTwip(settings.footerMargin),
          },
          size: { width: convertMillimetersToTwip(210), height: convertMillimetersToTwip(297) },
        },
        grid: { charSpace, linePitch, type: "linesAndChars" as const },
      },
      footers: {
        default: new Footer({
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [
                new TextRun({ text: '\u2014 ', font: '宋体', size: ptToHalfPt(14) }),
                new TextRun({ children: [PageNumber.CURRENT], font: '宋体', size: ptToHalfPt(14) }),
                new TextRun({ text: ' \u2014', font: '宋体', size: ptToHalfPt(14) }),
              ],
            }),
          ],
        }),
      },
      children,
    }],
  });
}

/** 递归：将单个 ProseMirror 节点附加到 children 数组 */
async function appendNode(
  node: PMNode,
  children: (Paragraph | Table)[],
  settings: ExportSettings,
  bodySpacing: ISpacingProperties,
  bodyWidthTwip: number,
  tblBorder: any,
) {
  switch (node.type) {
    case 'paragraph': {
      const attrs = node.attrs || {};
      const textRuns = node.content
        ? node.content.flatMap(c => buildTextRuns(c, settings, settings.fontBody, settings.sizeBody))
        : [new TextRun({ text: '' })];
      const paraIndent = parseTextIndentTwip(attrs.textIndent, settings.sizeBody);
      children.push(new Paragraph({
        children: textRuns,
        alignment: mapAlignment(attrs.textAlign),
        spacing: parseLineHeightSpacing(attrs.lineHeight, bodySpacing),
        indent: { firstLine: paraIndent ?? 0 },
      }));
      break;
    }

    case 'heading': {
      const level = (node.attrs?.level || 1) as 1 | 2 | 3 | 4;
      const attrs = node.attrs || {};
      const headingLevels: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel] | undefined> = {
        1: HeadingLevel.HEADING_1,
        2: HeadingLevel.HEADING_2,
        3: HeadingLevel.HEADING_3,
        4: HeadingLevel.HEADING_4,
      };
      const fontMap: Record<number, string> = {
        1: settings.fontH1, 2: settings.fontH2, 3: settings.fontH3, 4: settings.fontH4,
      };
      const sizeMap: Record<number, number> = {
        1: settings.sizeH1, 2: settings.sizeH2, 3: settings.sizeH3, 4: settings.sizeH4,
      };

      const font = fontMap[level] || settings.fontBody;
      const size = sizeMap[level] || settings.sizeBody;
      const textRuns = node.content
        ? node.content.flatMap(c => buildTextRuns(c, settings, font, size))
        : [new TextRun({ text: '', font, size: ptToHalfPt(size) })];

      // 逐段对齐：JSON textAlign 优先，否则标题默认（H1居中，其余两端对齐）
      const alignment = attrs.textAlign
        ? mapAlignment(attrs.textAlign)
        : (level === 1 ? AlignmentType.CENTER : AlignmentType.JUSTIFIED);

      const headingIndent = parseTextIndentTwip(attrs.textIndent, size);
      const headingSpacing = parseLineHeightSpacing(attrs.lineHeight, bodySpacing);

      children.push(new Paragraph({
        ...(headingLevels[level] ? { heading: headingLevels[level] } : {}),
        children: textRuns,
        alignment,
        spacing: headingSpacing,
        indent: { firstLine: headingIndent ?? 0 },
      }));
      break;
    }

    case 'bulletList':
    case 'orderedList': {
      for (const item of buildListParagraphs(node, node.type as 'bulletList' | 'orderedList', settings, bodySpacing)) {
        children.push(item);
      }
      break;
    }

    case 'blockquote': {
      for (const child of node.content || []) {
        await appendNode(child, children, settings, bodySpacing, bodyWidthTwip, tblBorder);
      }
      break;
    }

    case 'codeBlock': {
      const text = extractPlainText(node);
      children.push(new Paragraph({
        children: [new TextRun({ text, font: 'Consolas', size: ptToHalfPt(10.5) })],
        spacing: { line: 240, lineRule: "auto", before: 0, after: 0 },
        indent: { firstLine: 0 },
        shading: { type: 'solid', fill: 'F5F5F5' },
      }));
      break;
    }

    case 'horizontalRule': {
      children.push(new Paragraph({ spacing: { before: 0, after: 0 }, children: [] }));
      break;
    }

    case 'table': {
      await buildTable(node, children, settings, bodyWidthTwip, tblBorder);
      break;
    }

    case 'image': {
      await buildImage(node, children, bodyWidthTwip, settings);
      break;
    }

    default:
      // 未知节点类型，递归处理 content
      if (node.content) {
        for (const child of node.content) {
          await appendNode(child, children, settings, bodySpacing, bodyWidthTwip, tblBorder);
        }
      }
  }
}

/** 将 ProseMirror list 节点展开为带标记的 Paragraph 数组 */
function buildListParagraphs(
  node: PMNode,
  listType: 'bulletList' | 'orderedList',
  settings: ExportSettings,
  bodySpacing: ISpacingProperties,
): Paragraph[] {
  const result: Paragraph[] = [];
  let counter = 1;

  for (const item of node.content || []) {
    if (item.type !== 'listItem') continue;
    for (const sub of item.content || []) {
      if (sub.type === 'paragraph') {
        const textRuns = sub.content
          ? sub.content.flatMap(c => buildTextRuns(c, settings, settings.fontBody, settings.sizeBody))
          : [];
        const marker = listType === 'bulletList'
          ? '• '
          : `${counter++}. `;
        const markerRun = new TextRun({
          text: marker,
          font: settings.fontBody,
          size: ptToHalfPt(settings.sizeBody),
        });
        result.push(new Paragraph({
          children: [markerRun, ...textRuns],
          alignment: AlignmentType.JUSTIFIED,
          spacing: bodySpacing,
          indent: { firstLine: 0, left: 360 },
        }));
      } else if (sub.type === 'bulletList' || sub.type === 'orderedList') {
        result.push(...buildListParagraphs(
          sub,
          sub.type as 'bulletList' | 'orderedList',
          settings,
          bodySpacing,
        ));
      }
    }
  }

  return result;
}

async function buildTable(
  node: PMNode,
  children: (Paragraph | Table)[],
  settings: ExportSettings,
  bodyWidthTwip: number,
  tblBorder: any,
) {
  const rows: PMNode[] = node.content || [];
  if (rows.length === 0) { children.push(new Paragraph("")); return; }

  const colCount = Math.max(
    ...rows.map(r => (r.content || []).reduce((sum, c) => sum + (c.attrs?.colspan || 1), 0)),
    1,
  );
  const colWidth = Math.floor(bodyWidthTwip / colCount);
  const TABLE_FONT = "宋体";
  const TABLE_SIZE = 10.5;

  const tableRows = rows.map((row) =>
    new TableRow({
      children: (row.content || []).map((cell) => {
        const columnSpan = Number(cell.attrs?.colspan) || 1;
        const rowSpan = Number(cell.attrs?.rowspan) || 1;
        const cellRuns = cell.content && cell.content.length > 0
          ? cell.content.flatMap(c => buildTextRuns(c, settings, TABLE_FONT, TABLE_SIZE))
          : [new TextRun({ text: '', font: TABLE_FONT, size: ptToHalfPt(TABLE_SIZE) })];
        return new TableCell({
          verticalAlign: VerticalAlign.CENTER,
          margins: {
            top: convertMillimetersToTwip(settings.cellMarginTop),
            bottom: convertMillimetersToTwip(settings.cellMarginBottom),
            left: convertMillimetersToTwip(settings.cellMarginLeft),
            right: convertMillimetersToTwip(settings.cellMarginRight),
          },
          children: [
            new Paragraph({
              children: cellRuns,
              alignment: AlignmentType.CENTER,
              spacing: { line: ptToTwip(14), lineRule: "exact", before: 0, after: 0 },
            }),
          ],
          width: { size: colWidth * columnSpan, type: WidthType.DXA },
          columnSpan,
          rowSpan,
        });
      }),
    }),
  );

  children.push(new Table({
    rows: tableRows,
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: tblBorder, bottom: tblBorder, left: tblBorder, right: tblBorder,
      insideHorizontal: tblBorder, insideVertical: tblBorder,
    },
  }));
}

async function buildImage(
  node: PMNode,
  children: (Paragraph | Table)[],
  bodyWidthTwip: number,
  settings: ExportSettings,
) {
  // 优先使用持久化本地路径（localPath），回退到 src / href
  const localPath = node.attrs?.localPath;
  const src = (typeof localPath === 'string' && localPath) || node.attrs?.src || node.attrs?.href;
  if (!src) { children.push(new Paragraph("")); return; }
  try {
    let imageData: Uint8Array;
    let imageType: "png" | "jpg" | "gif" | "bmp" = "png";

    if (src.startsWith("data:")) {
      const resp = await fetch(src);
      const blob = await resp.blob();
      const buffer = await blob.arrayBuffer();
      imageData = new Uint8Array(buffer);
      const mime = src.match(/^data:(.*?);/)?.[1] || "";
      if (mime.includes("png")) imageType = "png";
      else if (mime.includes("gif")) imageType = "gif";
      else if (mime.includes("bmp")) imageType = "bmp";
      else imageType = "jpg";
    } else if (src.startsWith("http://") || src.startsWith("https://")) {
      const resp = await fetch(src);
      const blob = await resp.blob();
      const buffer = await blob.arrayBuffer();
      imageData = new Uint8Array(buffer);
      if (blob.type.includes("png")) imageType = "png";
      else if (blob.type.includes("gif")) imageType = "gif";
      else if (blob.type.includes("bmp")) imageType = "bmp";
      else imageType = "jpg";
    } else {
      const normalizedPath = normalizeImagePath(src);
      const raw = await invoke<number[]>("read_image_file", { path: normalizedPath });
      imageData = new Uint8Array(raw);
      const ext = normalizedPath.split(".").pop()?.toLowerCase() || "";
      if (ext === "png") imageType = "png";
      else if (ext === "gif") imageType = "gif";
      else if (ext === "bmp") imageType = "bmp";
      else if (ext === "jpg" || ext === "jpeg") imageType = "jpg";
      else if (ext === "webp") { imageData = await convertToPng(imageData, "image/webp"); imageType = "png"; }
      else if (ext === "svg") { imageData = await convertToPng(imageData, "image/svg+xml"); imageType = "png"; }
      else imageType = "jpg";
    }

    let dims = { width: 1, height: 1 };
    try { dims = await getImageDimensions(imageData); } catch { /* fallback */ }
    const bodyWidthPx = Math.round(bodyWidthTwip * 96 / 1440);
    const imgWidth = bodyWidthPx;
    const imgHeight = Math.round(bodyWidthPx * (dims.height / dims.width));

    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { line: 240, lineRule: "auto", before: 0, after: 0 },
      children: [
        new ImageRun({
          type: imageType,
          data: imageData,
          transformation: { width: imgWidth, height: imgHeight },
          altText: { name: node.attrs?.alt || "图片", title: node.attrs?.title || "", description: node.attrs?.alt || src },
        }),
      ],
    }));
  } catch {
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { line: 240, lineRule: "auto", before: 0, after: 0 },
      children: [
        new TextRun({ text: `[图片: ${node.attrs?.alt || src}]`, font: settings.fontBody, size: ptToHalfPt(16), italics: true, color: "999999" }),
      ],
    }));
  }
}

// ── 辅助函数 ─────────────────────────────────────────────
function extractPlainText(node: PMNode): string {
  if (node.type === 'text') return node.text || '';
  if (node.content) return node.content.map(extractPlainText).join('');
  return '';
}

function mapAlignment(a: string | undefined): (typeof AlignmentType)[keyof typeof AlignmentType] {
  switch (a) {
    case 'center': return AlignmentType.CENTER;
    case 'right': return AlignmentType.RIGHT;
    case 'justify': return AlignmentType.JUSTIFIED;
    default: return AlignmentType.JUSTIFIED;
  }
}

function getImageDimensions(data: Uint8Array): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([data]);
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve({ width: img.naturalWidth, height: img.naturalHeight }); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("无法解析图片尺寸")); };
    img.src = url;
  });
}

async function convertToPng(data: Uint8Array, mimeType: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([data], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) { URL.revokeObjectURL(url); reject(new Error("无法创建 canvas")); return; }
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob(async (b) => {
        if (!b) { reject(new Error("canvas 转 blob 失败")); return; }
        const buffer = await b.arrayBuffer();
        resolve(new Uint8Array(buffer));
      }, "image/png");
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`无法加载图片: ${mimeType}`)); };
    img.src = url;
  });
}

function normalizeImagePath(path: string): string {
  let p = path.replace(/^file:\/\/?/, "");
  p = decodeURIComponent(p);
  p = p.replace(/\\/g, "/");
  return p;
}

// ── XML 后处理（保持不变） ──────────────────────────────
async function postProcessDocx(buffer: ArrayBuffer, settings: ExportSettings): Promise<Blob> {
  const zip = await JSZip.loadAsync(buffer);

  const stylesFile = zip.file("word/styles.xml");
  if (stylesFile) {
    let stylesXml = await stylesFile.async("string");
    stylesXml = stylesXml.replace(
      /<w:pPrDefault><w:pPr>/g,
      '<w:pPrDefault><w:pPr><w:snapToGrid w:val="0"/>',
    );
    const styleStart = "<w:docDefaults>";
    const normalStyle =
      '<w:style w:type="paragraph" w:styleId="Normal">' +
      '<w:name w:val="Normal"/>' +
      '<w:pPr><w:ind w:firstLine="0" w:left="0"/></w:pPr>' +
      '</w:style>';
    stylesXml = stylesXml.replace(styleStart, normalStyle + styleStart);
    zip.file("word/styles.xml", stylesXml);
  }

  const docFile = zip.file("word/document.xml");
  if (docFile) {
    let docXml = await docFile.async("string");
    docXml = docXml.replace(/<w:pPr\s*\/>/g, '<w:pPr><w:snapToGrid w:val="0"/></w:pPr>');
    docXml = docXml.replace(
      /<w:pPr>(<w:pStyle[^>]*\/>)?/g,
      '<w:pPr>$1<w:snapToGrid w:val="0"/><w:widowControl w:val="0"/>',
    );
    docXml = docXml.replace(
      /<w:tc>[\s\S]*?<\/w:tc>/g,
      (tcBlock) => tcBlock.replace(/<w:ind[^>]*\/>/g, '<w:ind w:firstLine="0" w:left="0"/>'),
    );
    // 将所有 w:firstLine="NNN" (twip) 转换为 w:firstLineChars (百分之一字符)
    // 以正文字号为基准：chars = twip / (fontSizePt × 20) × 100
    const bodySizeTwipPerChar = settings.sizeBody * 20;
    docXml = docXml.replace(
      /w:firstLine="(\d+)"/g,
      (_m, twipStr) => {
        const twip = parseInt(twipStr);
        if (twip <= 0) return _m;
        const chars = Math.round(twip / bodySizeTwipPerChar * 100);
        return `w:firstLineChars="${chars}"`;
      },
    );
    if (!docXml.includes("<w:overflowPunct")) {
      docXml = docXml.replace(
        /<w:sectPr([^>]*)>/g,
        '<w:sectPr$1><w:overflowPunct w:val="0"/>',
      );
    }
    zip.file("word/document.xml", docXml);
  }

  const settingsFile = zip.file("word/settings.xml");
  if (settingsFile) {
    let settingsXml = await settingsFile.async("string");
    if (settingsXml.includes("<w:widowControl")) {
      settingsXml = settingsXml.replace(/<w:widowControl[^>]*\/>/g, '<w:widowControl w:val="0"/>');
    } else {
      settingsXml = settingsXml.replace(/<w:settings([^>]*)>/, '<w:settings$1><w:widowControl w:val="0"/>');
    }
    if (settingsXml.includes("<w:compat>")) {
      if (settingsXml.includes("<w:overflowPunct")) {
        settingsXml = settingsXml.replace(/<w:overflowPunct[^>]*\/>/g, '<w:overflowPunct w:val="0"/>');
      } else {
        settingsXml = settingsXml.replace(/<w:compat>/g, '<w:compat><w:overflowPunct w:val="0"/>');
      }
      if (!settingsXml.includes("<w:doNotSnapToGridInCell")) {
        settingsXml = settingsXml.replace(/<w:compat>/g, '<w:compat><w:doNotSnapToGridInCell/>');
      }
    } else {
      settingsXml = settingsXml.replace(
        /<\/w:settings>/,
        '<w:compat><w:overflowPunct w:val="0"/><w:doNotSnapToGridInCell/></w:compat></w:settings>',
      );
    }
    zip.file("word/settings.xml", settingsXml);
  }

  return zip.generateAsync({
    type: "blob",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

// ── 导出入口 ──────────────────────────────────────────────
export async function exportToWord(
  content: string,
  title: string,
  settings: ExportSettings = DEFAULT_EXPORT_SETTINGS,
) {
  try {
    const doc = parseContent(content);
    const docxDoc = await buildDocx(doc, settings);
    const rawBlob = await Packer.toBlob(docxDoc);
    const rawBuf = await rawBlob.arrayBuffer();
    const fixedBlob = await postProcessDocx(rawBuf, settings);
    const arrayBuffer = await fixedBlob.arrayBuffer();
    const data = Array.from(new Uint8Array(arrayBuffer));

    const filePath = await save({
      filters: [{ name: "Word 文档", extensions: ["docx"] }],
      defaultPath: `${title || "文档"}.docx`,
    });

    if (!filePath) return;

    // 检查文件状态
    const status = await invoke<{ exists: boolean; writable: boolean }>("check_file_writable", { path: filePath });

    if (status.exists && !status.writable) {
      // 文件存在但被锁定（如 Word 正在打开）
      await message("文件正被其他程序占用，请关闭后再试。", { title: "无法保存", kind: "error" });
      return;
    }

    if (status.exists) {
      const confirmed = await ask(`文件"${filePath.split(/[\\/]/).pop()}"已存在，是否替换？`, {
        title: "确认替换",
        kind: "warning",
      });
      if (!confirmed) return;
    }

    try {
      await invoke("export_word_file", { path: filePath, data });
    } catch (writeErr) {
      const msg = String(writeErr);
      await message(
        msg.includes("被占用") || msg.includes("access") || msg.includes("拒绝")
          ? "文件正被其他程序占用，请关闭后再试。"
          : `写入文件失败：${msg}`,
        { title: "保存失败", kind: "error" },
      );
      return;
    }

    console.log("[exportWord] 文件已保存:", filePath);
  } catch (err) {
    console.error("[exportWord] 导出失败:", err);
    await message(`导出失败：${err}`, { title: "导出错误", kind: "error" });
  }
}
