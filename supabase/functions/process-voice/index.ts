import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY");
const GROQ_AUDIO_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (!GROQ_API_KEY) {
      throw new Error("GROQ_API_KEY no está configurada en los secretos de Supabase.");
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      throw new Error("Falta el encabezado de autenticación Authorization.");
    }

    // Inicializar cliente Supabase para validar al usuario y obtener su contexto
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userError } = await supabaseClient.auth.getUser();
    if (userError || !user) {
      throw new Error("Usuario no autenticado o sesión expirada.");
    }

    // Consultar cuentas del usuario para usar Interbank por defecto
    const { data: accounts } = await supabaseClient
      .from("accounts")
      .select("id, name, is_default");

    const defaultAcc = (accounts || []).find((a: any) => a.is_default) || accounts?.[0] || { id: "interbank", name: "Interbank" };
    const accountsList = (accounts || []).map((a: any) => `${a.id} (${a.name})`).join(", ");

    // Procesar archivo de audio multipart/form-data
    const formData = await req.formData();
    const audioFile = formData.get("file");
    if (!audioFile) {
      throw new Error("No se envió ningún archivo de audio en la petición.");
    }

    // 1. Transcribir audio con Groq Whisper Large v3 Turbo
    const whisperFormData = new FormData();
    whisperFormData.append("file", audioFile);
    whisperFormData.append("model", "whisper-large-v3-turbo");
    whisperFormData.append("language", "es");
    whisperFormData.append("prompt", "Finanzas personales, soles, dólares, Interbank, Yape, Plin, BCP, efectivo, papá, mamá, me debe, le debo, me pagó, presté, lucas.");

    const whisperResponse = await fetch(GROQ_AUDIO_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GROQ_API_KEY}`
      },
      body: whisperFormData
    });

    if (!whisperResponse.ok) {
      const err = await whisperResponse.json().catch(() => ({}));
      throw new Error(err.error?.message || "Error al transcribir audio con Whisper en Groq.");
    }

    const whisperResult = await whisperResponse.json();
    const transcript = whisperResult.text || "";

    if (!transcript.trim()) {
      return new Response(JSON.stringify({
        success: true,
        transcript: "",
        parsed: {
          es_conversacion: true,
          mensaje: "No se detectó audio claro. Intenta hablar nuevamente."
        }
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // 2. Extraer datos estructurados con Groq (OpenAI GPT-OSS 20B a 1000 tps)
    const todayISO = new Date().toISOString().split("T")[0];
    const systemPrompt = `Eres un asistente de inteligencia artificial de finanzas personales para registrar ingresos, egresos, transferencias y control de deudas/préstamos en Perú/Latinoamérica.
Tu objetivo es analizar la frase hablada por el usuario y extraer una transacción estructurada en formato JSON estricto.

FECHA DE HOY: ${todayISO}
CUENTA PRINCIPAL POR DEFECTO: "${defaultAcc.id}" (${defaultAcc.name})
OTRAS CUENTAS DISPONIBLES: [${accountsList}]

REGLAS DE INTERPRETACIÓN:
1. tipo: Debe ser uno de: "egreso" | "ingreso" | "transferencia" | "deuda_cobrar" | "cobro_deuda" | "deuda_pagar" | "pago_deuda".
   - "deuda_cobrar": Si alguien le debe dinero o le prestó a alguien (ej: "Mi papá me debe 127.82 soles", "Juan me debe 50 soles").
   - "cobro_deuda": Si alguien le pagó una deuda (ej: "Juan me pagó lo que me debía", "Mi papá ya me pagó").
   - "deuda_pagar": Si el usuario le debe dinero a alguien (ej: "Le debo 35 soles a María").
   - "pago_deuda": Si el usuario le pagó su deuda a alguien (ej: "Le pagué a María").
2. persona: Si es deuda ("deuda_cobrar", "cobro_deuda", etc.), nombre de la persona (ej: "Papá", "Juan", "Carlos"). Si no aplica: null.
3. monto: Número en decimales positivo (ej. 127.82).
4. moneda: "PEN" si son soles o no especifica; "USD" si dice dólares.
5. cuenta: El ID de la cuenta usada.
   - REGLA ABSOLUTA: La cuenta principal es "${defaultAcc.id}". Si no menciona otra cuenta bancaria explícita, asigna SIEMPRE "${defaultAcc.id}".
   - Para deudas: asigna SIEMPRE "${defaultAcc.id}". Nunca uses "efectivo" a menos que diga literalmente "en efectivo".
6. categoria: Para "deuda_cobrar" o "deuda_pagar" usa "Préstamos y Deudas". Para "cobro_deuda" usa "Cobro de Deuda". Para egresos: la más adecuada ("Alimentación", "Transporte", etc.).
7. descripcion: Resumen conciso (ej. "Deuda de papá", "Almuerzo").
8. fecha: En formato YYYY-MM-DD (hoy es ${todayISO}).

FORMATO DE SALIDA (JSON ÚNICAMENTE):
{
  "tipo": "egreso" | "ingreso" | "transferencia" | "deuda_cobrar" | "cobro_deuda" | "deuda_pagar" | "pago_deuda",
  "persona": "Nombre o null",
  "monto": 0.00,
  "moneda": "PEN",
  "cuenta": "${defaultAcc.id}",
  "cuenta_destino": null,
  "categoria": "Categoría",
  "descripcion": "Descripción concisa",
  "fecha": "${todayISO}"
}`;

    const chatResponse = await fetch(GROQ_CHAT_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-20b",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: transcript }
        ],
        response_format: { type: "json_object" },
        temperature: 0.1
      })
    });

    if (!chatResponse.ok) {
      const err = await chatResponse.json().catch(() => ({}));
      throw new Error(err.error?.message || "Error al interpretar transacción con Groq.");
    }

    const chatResult = await chatResponse.json();
    const rawContent = chatResult.choices[0]?.message?.content || "{}";
    const parsed = JSON.parse(rawContent);

    // Asegurar fallback de cuenta principal
    if (!parsed.cuenta || parsed.cuenta === "null" || (parsed.cuenta === "efectivo" && !transcript.toLowerCase().includes("efectivo"))) {
      parsed.cuenta = defaultAcc.id;
    }

    parsed.rawSpeech = transcript;

    return new Response(JSON.stringify({
      success: true,
      transcript,
      parsed
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });

  } catch (err: any) {
    console.error("Error en Edge Function process-voice:", err);
    return new Response(JSON.stringify({
      error: err.message || "Error interno procesando audio."
    }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});
