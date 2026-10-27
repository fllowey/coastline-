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
  const failures = [];
  try {
    jobs.set(id, { status: "processing", output: null, error: null, provider: "WeShopAI" });
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "coastline-"));
    const personPath = path.join(dir, "person." + person.ext);
    const garmentPath = path.join(dir, "garment." + garment.ext);
    await Promise.all([
      fs.writeFile(personPath, person.buffer),
      fs.writeFile(garmentPath, garment.buffer)
    ]);

    const auth = process.env.HF_TOKEN ? { token: process.env.HF_TOKEN } : {};
    const providers = [
      {
        name: "WeShopAI",
        space: "WeShopAI/WeShopAI-Virtual-Try-On",
        run: async client => {
          const result = await client.predict("/generate_image", [
            handle_file(garmentPath),
            handle_file(personPath),
            crypto.randomUUID()
          ]);
          return extractImage(result?.data);
        }
      },
      {
        name: "WeShopAI backup",
        space: "sikil/WeShopAI-Virtual-Try-On",
        run: async client => {
          const result = await client.predict("/generate_image", [
            handle_file(garmentPath),
            handle_file(personPath),
            crypto.randomUUID()
          ]);
          return extractImage(result?.data);
        }
      },
      {
        name: "FASHN VTON 1.5",
        space: "fashn-ai/fashn-vton-1.5",
        generationTimeout: 120000,
        run: async client => {
          const mappedCategory = category === "bottoms" ? "bottoms" : category === "one-pieces" ? "one-pieces" : "tops";
          const result = await client.predict("/try_on", [
            handle_file(personPath),
            handle_file(garmentPath),
            mappedCategory,
            "flat-lay",
            25,
            1.5,
            -1,
            true
          ]);
          return extractImage(result?.data);
        }
      },
      {
        name: "OOTDiffusion backup",
        space: "levihsu/OOTDiffusion",
        run: async client => {
          const mappedCategory = category === "bottoms" ? "Lower-body" : category === "one-pieces" ? "Dress" : "Upper-body";
          const result = await client.predict("/process_dc", [
            handle_file(personPath),
            handle_file(garmentPath),
            mappedCategory,
            1,
            20,
            2,
            -1
          ]);
          return extractImage(result?.data);
        }
      }
    ];

    // A timeout lets COASTLINE move on even if a public Space hangs.
    const withTimeout = (promise, ms, label) => Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(label + " timed out after " + ms + "ms")), ms))
    ]);
    const isHardStop = message => /quota exceeded|ZeroGPU|runs limit|401|403|unauthorized|forbidden|invalid token|api_name|endpoint|parameters|unexpected argument/i.test(message);

    for (const provider of providers) {
      let succeeded = false;
      // One automatic retry for transient errors; quota/auth/API errors go straight to the next provider.
      for (let attempt = 1; attempt <= 2 && !succeeded; attempt++) {
        try {
          jobs.set(id, { status: "processing", output: null, error: null, provider: provider.name, attempt });
          console.log("COASTLINE trying AI provider:", provider.name, "(" + provider.space + "), attempt", attempt);
          const client = await withTimeout(Client.connect(provider.space, auth), 45000, provider.name + " connection");
          const outputUrl = await withTimeout(provider.run(client), 65000, provider.name + " generation");
          if (!outputUrl) throw new Error("Provider returned no usable image URL.");
          console.log("COASTLINE AI provider succeeded:", provider.name);
          jobs.set(id, { status: "completed", output: [outputUrl], error: null, provider: provider.name });
          succeeded = true;
          return;
        } catch (error) {
          const message = String(error?.message || error?.details?.message || error);
          failures.push(provider.name + " attempt " + attempt + ": " + message);
          console.error("COASTLINE provider failed:", provider.name, "attempt", attempt, message);
          if (attempt === 1 && !isHardStop(message)) {
            jobs.set(id, { status: "processing", output: null, error: null, provider: provider.name, attempt: 2, fallbackMessage: "Повторяем запрос к текущему AI-сервису…" });
            await new Promise(resolve => setTimeout(resolve, 1200));
          } else {
            break;
          }
        }
      }
    }

    const diagnostics = failures.join(" | ");
    let userMessage = "Все бесплатные AI-сервисы сейчас недоступны. Попробуй позже — сайт автоматически проверил резервные варианты.";
    if (/ZeroGPU quota exceeded|quota exceeded|runs limit/i.test(diagnostics)) {
      userMessage = "Бесплатные AI-сервисы исчерпали доступные лимиты. COASTLINE автоматически попробовал резервные модели, но сейчас они тоже недоступны. Попробуй позже.";
    } else if (/401|403|auth|token|unauthorized|forbidden/i.test(diagnostics)) {
      userMessage = "Резервные AI-сервисы отклонили доступ. Проверь HF_TOKEN в Render → Environment. Не вставляй токен в код сайта.";
    }
    jobs.set(id, { status: "failed", output: null, error: userMessage });
    console.error("All COASTLINE AI providers failed:", diagnostics);
  } catch (error) {
    console.error("COASTLINE try-on orchestration failed:", error?.stack || error);
    jobs.set(id, { status: "failed", output: null, error: "Не удалось запустить AI-примерку. Попробуй позже." });
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
