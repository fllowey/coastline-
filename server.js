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

    // Inputs match the public Space app.py run_button.click order:
    // person_image, garment_image, category, garment_photo_type,
    // num_timesteps, guidance_scale, seed, segmentation_free.
    console.log("Connecting to public Hugging Face Space:", SPACE_ID);
    const client = await Client.connect(SPACE_ID, process.env.HF_TOKEN ? { token: process.env.HF_TOKEN } : {});
    console.log("Connected. Starting virtual try-on.");
    const result = await client.predict("/try_on", [
      handle_file(personPath),
      handle_file(garmentPath),
      category,
      "flat-lay",
      20,
      1.5,
      Math.floor(Math.random() * 1000000),
      true
    ]);

    const outputUrl = extractImage(result?.data);
    if (!outputUrl) {
      console.error("Unexpected Hugging Face result:", JSON.stringify(result).slice(0, 1800));
      throw new Error("AI-сервис не вернул изображение.");
    }
    jobs.set(id, { status: "completed", output: [outputUrl], error: null });
  } catch (error) {
    console.error("COASTLINE Hugging Face try-on failed:", error?.stack || error);
    const message = String(error?.message || "");
    let userMessage = "Бесплатный AI-сервис временно недоступен. Попробуй позже.";
    if (/queue|busy|rank|timeout|sleeping|starting|loading/i.test(message)) userMessage = "AI сейчас занят или запускается. Подожди минуту и попробуй снова.";
    if (/api_name|endpoint|parameters|validation|unexpected argument/i.test(message)) userMessage = "AI-модель изменила API. Нужно обновить подключение.";
    if (/401|403|auth|token/i.test(message)) userMessage = "AI-сервис требует дополнительного доступа. Бесплатный запуск сейчас недоступен.";
    jobs.set(id, { status: "failed", output: null, error: userMessage });
  } finally {
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
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
