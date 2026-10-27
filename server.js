import express from "express";
import dotenv from "dotenv";
import helmet from "helmet";
dotenv.config();
const app=express(), PORT=process.env.PORT||3000, KEY=process.env.FASHN_API_KEY;
app.disable("x-powered-by");
app.use(helmet({contentSecurityPolicy:false,crossOriginEmbedderPolicy:false}));
app.use(express.json({limit:"20mb"}));
app.use(express.static("public"));
app.post("/api/tryon",async(req,res)=>{
 if(!KEY)return res.status(503).json({error:"AI не подключён: добавь FASHN_API_KEY в секреты хостинга."});
 const {model_image,garment_image,category="tops"}=req.body??{};
 const valid=v=>typeof v==="string"&&/^data:image\/(png|jpeg|jpg|webp);base64,/i.test(v)&&v.length<11_000_000;
 if(!valid(model_image)||!valid(garment_image))return res.status(400).json({error:"Нужны два изображения PNG, JPG или WEBP до 8 МБ каждое."});
 if(!["tops","bottoms","one-pieces"].includes(category))return res.status(400).json({error:"Неверная категория одежды."});
 try{const r=await fetch("https://api.fashn.ai/v1/run",{method:"POST",headers:{Authorization:"Bearer "+KEY,"Content-Type":"application/json"},body:JSON.stringify({model_name:"tryon-v1.6",inputs:{model_image,garment_image,category,mode:"balanced",garment_photo_type:"auto",num_samples:1,output_format:"png"}})});const d=await r.json().catch(()=>({}));if(!r.ok)return res.status(502).json({error:d.message||d.error||"Ошибка AI-сервиса."});if(!d.id)return res.status(502).json({error:"AI не вернул ID задачи."});res.json({id:d.id})}catch(e){console.error(e);res.status(502).json({error:"Не удалось связаться с AI-сервисом."})}
});
app.get("/api/tryon/status/:id",async(req,res)=>{
 if(!KEY)return res.status(503).json({error:"AI не подключён: добавь FASHN_API_KEY в секреты хостинга."});
 if(!/^[a-zA-Z0-9-]{5,160}$/.test(req.params.id))return res.status(400).json({error:"Некорректный ID задачи."});
 try{const r=await fetch("https://api.fashn.ai/v1/status/"+encodeURIComponent(req.params.id),{headers:{Authorization:"Bearer "+KEY}});const d=await r.json().catch(()=>({}));if(!r.ok)return res.status(502).json({error:d.message||d.error||"Не удалось получить статус."});res.json({id:d.id,status:d.status,output:d.output,error:d.error})}catch(e){console.error(e);res.status(502).json({error:"Потеряно соединение с AI-сервисом."})}
});
app.listen(PORT,()=>console.log("COASTLINE listening on "+PORT));