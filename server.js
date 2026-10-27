import express from "express";
import dotenv from "dotenv";
import helmet from "helmet";
import { Client, handle_file } from "@gradio/client";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: "20mb" }));
app.use(express.static(process.cwd()));

const jobs = new Map();
const SPACE_ID = "merve/fashn-vton-1.5";

function imageData(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^data:image\/(png|jpeg|jpg|webp);base64,([\s\S]+)$/i);
  if (!match) return null;
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > 8 * 1024 * 1024) return null;
  const ext = match[1].toLowerCase() === "jpeg" ? "jpg" : match[1].toLowerCase();
  return { buffer, ext };
}

function chooseEndpoint(api) {
  const endpoints = Object.entries(api?.named_endpoints || {});
  const candidates = endpoints.filter(([, info]) =>
    (info.parameters || []).filter(p => /image/i.test(String(p.component || ""))).length >= 2
  );
  if (candidates.length) return candidates[0];
  if (endpoints.length === 1) return endpoints[0];
  throw new Error("В публичном AI-пространстве не найден endpoint для двух изображений.");
}

function buildPayload(parameters, personPath, garmentPath, category) {
  let personUsed = false;
  let garmentUsed = false;
  return (parameters || []).map((p, index) => {
    const label = String(p.label || p.name || "").toLowerCase();
    const component = String(p.component || "").toLowerCase();
    const type = String(p.type || "").toLowerCase();
    const example = p.example_input;
    if (component.includes("image") || /image|photo|picture|model|person|garment|clothing|cloth/.test(label)) {
      if (!personUsed && /person|human|model|person image|human image/.test(label)) {
        personUsed = true; return handle_file(personPath);
      }
      if (!garmentUsed && /garment|clothing|cloth|product|apparel/.test(label)) {
        garmentUsed = true; return handle_file(garmentPath);
      }
      if (!personUsed) { personUsed = true; return handle_file(personPath); }
      if (!garmentUsed) { garmentUsed = true; return handle_file(garmentPath); }
    }
    if (/category|garment type|clothing type/.test(label)) return category;
    if (/seed/.test(label)) return typeof example === "number" ? example : 42;
    if (/steps|inference/.test(label)) return typeof example === "number" ? example : 30;
    if (/guidance|scale/.test(label)) return typeof example === "number" ? example : 2;
    if (/random/.test(label) && component.includes("checkbox")) return false;
    if (example !== undefined && example !== null) return example;
    if (component.includes("checkbox") || type.includes("boolean")) return false;
    if (component.includes("slider") || component.includes("number")) return 1;
    if (component.includes("dropdown") || component.includes("radio")) return category;
    if (component.includes("textbox")) return "";
    return undefined;
  });
}

function extractImage(value) {
  if (!value) return null;
  if (typeof value === "string" && /^https?:\/\//i.test(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) { const found = extractImage(item); if (found) return found; }
  }
  if (typeof value === "object") {
    if (typeof value.url === "string") return value.url;
    if (typeof value.path === "string" && /^https?:\/\//i.test(value.path)) return value.path;
    for (const key of ["image", "output", "images", "value"]) {
      const found = extractImage(value[key]); if (found) return found;
    }
  }
  return null;
}

async function runTryOn(id, person, garment, category) {
  let dir;
  try {
    jobs.set(id, { status: "processing", output: null, error: null });
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "coastline-"));
    const personPath = path.join(dir, "person." + person.ext);
    const garmentPath = path.join(dir, "garment." + garment.ext);
    await Promise.all([
      fs.writeFile(personPath, person.buffer),
      fs.writeFile(garmentPath, garment.buffer)
    ]);

    const client = await Client.connect(SPACE_ID);
    const api = await client.view_api();
    const [apiName, endpoint] = chooseEndpoint(api);
    const payload = buildPayload(endpoint.parameters, personPath, garmentPath, category);
    const result = await client.predict(apiName, payload);
    const outputUrl = extractImage(result?.data);
    if (!outputUrl) {
      console.error("Unexpected Hugging Face result:", JSON.stringify({ apiName, result }).slice(0, 1800));
      throw new Error("AI-сервис не вернул изображение.");
    }
    jobs.set(id, { status: "completed", output: [outputUrl], error: null });
  } catch (error) {
    console.error("COASTLINE Hugging Face try-on failed:", error);
    const message = String(error?.message || "");
    let userMessage = "Бесплатный AI-сервис временно недоступен. Попробуй позже.";
    if (/queue|busy|rank|timeout|sleeping/i.test(message)) userMessage = "AI сейчас занят или запускается. Подожди немного и попробуй снова.";
    if (/endpoint|parameters|image/i.test(message)) userMessage = "Не удалось согласовать входные поля с AI-моделью. Нужна проверка API этой модели.";
    jobs.set(id, { status: "failed", output: null, error: userMessage });
  } finally {
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

app.post("/api/tryon", async (req, res) => {
  const { model_image, garment_image, category = "tops" } = req.body ?? {};
  const person = imageData(model_image);
  const garment = imageData(garment_image);
  if (!person || !garment) {
    return res.status(400).json({ error: "Загрузи два изображения PNG, JPG или WEBP размером до 8 МБ каждое." });
  }
  if (!["tops", "bottoms", "one-pieces"].includes(category)) {
    return res.status(400).json({ error: "Неверная категория одежды." });
  }
  if (jobs.size > 40) {
    for (const [key, value] of jobs) {
      if (["completed", "failed"].includes(value.status)) jobs.delete(key);
      if (jobs.size <= 20) break;
    }
  }
  const id = crypto.randomUUID();
  jobs.set(id, { status: "queued", output: null, error: null });
  res.json({ id });
  runTryOn(id, person, garment, category);
});

app.get("/api/tryon/status/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Задача не найдена или сервер перезапустился. Запусти примерку ещё раз." });
  res.json({ id: req.params.id, status: job.status, output: job.output, error: job.error });
});

app.listen(PORT, () => console.log("COASTLINE listening on " + PORT));
