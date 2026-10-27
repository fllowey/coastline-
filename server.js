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
const SPACE_ID = "WeShopAI/WeShopAI-Virtual-Try-On";

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

    // WeShopAI's public trial Space uses a different UI/API from FASHN.
    // Inspect its live Gradio schema so endpoint names and parameter order are not guessed.
    console.log("Connecting to public Hugging Face Space:", SPACE_ID);
    const client = await Client.connect(SPACE_ID, process.env.HF_TOKEN ? { token: process.env.HF_TOKEN } : {});
    const api = await client.view_api();
    console.log("WeShopAI API schema:", JSON.stringify(api).slice(0, 9000));
    const endpoints = api?.named_endpoints || {};
    const candidates = Object.entries(endpoints).filter(([name, ep]) =>
      /generate|try.?on|predict|submit/i.test(name) &&
      Array.isArray(ep?.parameters) &&
      ep.parameters.some(p => /garment|cloth|main.?image|product.?image/i.test(String(p.parameter_name || p.label || ""))) &&
      ep.parameters.some(p => /person|human|background.?reference|model.?image/i.test(String(p.parameter_name || p.label || "")))
    );
    if (!candidates.length) throw new Error("WeShopAI API schema did not expose a recognizable garment/person endpoint.");
    const [apiName, endpoint] = candidates[0];
    const payload = endpoint.parameters.map(p => {
      const name = String(p.parameter_name || p.label || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      if (/garment|cloth|mainimage|productimage/.test(name)) return handle_file(garmentPath);
      if (/person|human|backgroundreference|modelimage/.test(name)) return handle_file(personPath);
      if (/category|clothcategory/.test(name)) return category;
      if (Object.prototype.hasOwnProperty.call(p, "parameter_default")) return p.parameter_default;
      return null;
    });
    console.log("Calling WeShopAI endpoint:", apiName, "with", payload.length, "inputs.");
    const result = await client.predict(apiName, payload);

    const outputUrl = extractImage(result?.data);
    if (!outputUrl) {
      console.error("Unexpected Hugging Face result:", JSON.stringify(result).slice(0, 1800));
      throw new Error("AI-сервис не вернул изображение.");
    }
    jobs.set(id, { status: "completed", output: [outputUrl], error: null });
  } catch (error) {
    console.error("COASTLINE Hugging Face try-on failed:", error?.stack || error);
    const message = String(error?.message || error?.details?.message || "");
    const details = JSON.stringify(error || {});
    const diagnostic = message + " " + details;
    let userMessage = "Бесплатный AI-сервис временно недоступен. Попробуй позже.";
    if (/ZeroGPU quota exceeded|quota exceeded|runs limit/i.test(diagnostic)) {
      userMessage = process.env.HF_TOKEN
        ? "Бесплатная GPU-квота Hugging Face исчерпана. Подожди сброса дневного лимита или используй другой доступный AI-сервис."
        : "Бесплатная GPU-квота Hugging Face исчерпана. Добавь личный HF_TOKEN в Render → Environment, чтобы использовать квоту своего бесплатного аккаунта.";
    } else if (/queue|busy|rank|timeout|sleeping|starting|loading/i.test(diagnostic)) {
      userMessage = "AI сейчас занят или запускается. Подожди минуту и попробуй снова.";
    } else if (/api_name|endpoint|parameters|validation|unexpected argument/i.test(diagnostic)) {
      userMessage = "AI-модель изменила API. Нужно обновить подключение.";
    } else if (/401|403|auth|token|unauthorized|forbidden/i.test(diagnostic)) {
      userMessage = "Hugging Face отклонил доступ. Проверь HF_TOKEN в Render → Environment; токен не вставляй в код сайта.";
    }
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
