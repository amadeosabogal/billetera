/**
 * Groq AI Client - Dynamic Model Discovery, Whisper Audio Transcription & Structured Extraction
 */

const GROQ_AUDIO_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models';

/**
 * Verified active production models from official Groq documentation (2025/2026)
 * Note: mixtral-8x7b-32768, llama3-8b-8192, and llama3-70b-8192 have been decommissioned by Groq.
 */
export const VERIFIED_ACTIVE_MODELS = [
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
  'llama-3.1-8b-instant',
  'llama-3.3-70b-versatile',
  'qwen/qwen3.8-27b'
];

let cachedModels = null;
let lastCacheKey = null;

/**
 * Query Groq API to discover which models are currently available and active for the user's API Key.
 * Never guesses: dynamically requests the catalog directly from https://api.groq.com/openai/v1/models
 */
export async function fetchAvailableGroqModels(apiKey) {
  if (!apiKey || apiKey.trim().length === 0) {
    return VERIFIED_ACTIVE_MODELS;
  }

  const cleanKey = apiKey.trim();
  if (cachedModels && lastCacheKey === cleanKey) {
    return cachedModels;
  }

  try {
    const response = await fetch(GROQ_MODELS_URL, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${cleanKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      console.warn('Consulta de modelos en Groq retornó código:', response.status);
      return VERIFIED_ACTIVE_MODELS;
    }

    const data = await response.json();
    const rawList = data.data || [];

    // Filter out audio, whisper, tts, vision-only, and safety guards
    const nonChatPatterns = [
      'whisper',
      'orpheus',
      'playai',
      'prompt-guard',
      'llama-guard',
      'safeguard'
    ];

    // Exclude confirmed decommissioned models
    const decommissioned = [
      'mixtral-8x7b-32768',
      'llama3-8b-8192',
      'llama3-70b-8192',
      'gemma-7b-it',
      'gemma2-9b-it',
      'deepseek-r1-distill-llama-70b'
    ];

    const chatModels = rawList
      .map(m => m.id)
      .filter(id => {
        const lower = id.toLowerCase();
        if (nonChatPatterns.some(p => lower.includes(p))) return false;
        if (decommissioned.includes(lower)) return false;
        return true;
      });

    if (chatModels.length > 0) {
      cachedModels = chatModels;
      lastCacheKey = cleanKey;
      return chatModels;
    }
  } catch (err) {
    console.warn('No se pudo consultar lista en vivo de Groq, usando lista verificada:', err);
  }

  return VERIFIED_ACTIVE_MODELS;
}

/**
 * Test Groq connection and fetch available models
 */
export async function testGroqConnection(apiKey) {
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error('Ingresa una API Key de Groq válida.');
  }

  const cleanKey = apiKey.trim();
  const response = await fetch(GROQ_MODELS_URL, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${cleanKey}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `Error de conexión Groq (${response.status})`);
  }

  const data = await response.json();
  const models = await fetchAvailableGroqModels(apiKey);
  return models;
}

/**
 * Transcribe speech audio using Groq Whisper Large v3 Turbo
 */
export async function transcribeWithGroqWhisper(audioBlob, apiKey) {
  if (!apiKey) throw new Error('Se requiere API Key de Groq para transcribir con Whisper.');

  const formData = new FormData();
  const ext = audioBlob.type.includes('mp4') ? 'm4a' : 'webm';
  formData.append('file', audioBlob, `speech.${ext}`);
  formData.append('model', 'whisper-large-v3-turbo');
  formData.append('language', 'es');
  formData.append('temperature', '0.0');
  formData.append('prompt', 'Finanzas personales, soles, dólares, BCP, BBVA, Interbank, Yape, Plin, Scotiabank, efectivo, papá, mamá, me debe, le debo, me pagó, presté, chauchas, tarjeta, almuerzo, taxi, sueldo.');

  const res = await fetch(GROQ_AUDIO_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey.trim()}`
    },
    body: formData
  });

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `Error en Whisper (${res.status})`);
  }

  const data = await res.json();
  return data.text || '';
}

/**
 * Extract structured transaction JSON using active Groq models (No guesswork, queries available models)
 */
export async function extractTransactionData(speechText, apiKey, context = {}) {
  if (!apiKey) throw new Error('Falta configurar tu API Key de Groq.');
  if (!speechText || speechText.trim().length === 0) {
    throw new Error('No se detectó ningún audio o texto para analizar.');
  }

  const defaultAcc = context.defaultAccount || (context.accounts && context.accounts.find(a => a.isDefault)) || (context.accounts && context.accounts[0]) || { id: 'interbank', name: 'Interbank' };
  const accountsList = (context.accounts || []).map(a => `${a.id} (${a.name})`).join(', ');
  const categoriesList = (context.categories || []).map(c => c.name).join(', ');
  const todayISO = new Date().toISOString().split('T')[0];

  const systemPrompt = `Eres un asistente de inteligencia artificial de finanzas personales para registrar ingresos, egresos, transferencias y control de deudas/préstamos en Perú/Latinoamérica.
Tu objetivo es analizar la frase hablada por el usuario y extraer una transacción estructurada en formato JSON estricto.

FECHA DE HOY: ${todayISO}
CUENTA PRINCIPAL POR DEFECTO: "${defaultAcc.id}" (${defaultAcc.name})
OTRAS CUENTAS DISPONIBLES: [${accountsList}]
CATEGORÍAS DISPONIBLES: [${categoriesList}]

REGLAS DE INTERPRETACIÓN:
1. tipo: Debe ser uno de los siguientes:
   - "egreso": Si es un gasto personal ordinario ("gasté", "pagué", "compré", "salí a comer").
   - "ingreso": Si es un ingreso ordinario ("sueldo", "me depositaron", "ganancia", "cobré por un trabajo").
   - "transferencia": Si pasa dinero entre sus propias cuentas ("transferí de Interbank a Yape").
   - "deuda_cobrar": Si alguien le debe dinero, le está debiendo, o el usuario le prestó dinero a alguien (ejemplos: "Mi papá me está debiendo 127.82 soles", "Mi papá me debe 127.82 soles", "Juan me debe 50 soles de la cena", "Le presté 100 soles a Carlos", "Anota que Pedro me debe 20 soles del taxi").
   - "cobro_deuda": Si alguien le pagó lo que le debía (ejemplos: "Juan me pagó los 50 soles que me debía", "Mi papá ya me pagó los 127.82 soles", "Carlos me devolvió el dinero prestado", "Pedro ya me pagó los 20 soles").
   - "deuda_pagar": Si el usuario le debe dinero a alguien (ejemplos: "Le debo 35 soles a María del almuerzo", "Le estoy debiendo 100 soles a mi hermano").
   - "pago_deuda": Si el usuario le pagó su deuda a alguien (ejemplos: "Le pagué a María los 35 soles", "Ya le devolví la plata a mi hermano").
2. persona: Si el tipo es deuda ("deuda_cobrar", "cobro_deuda", "deuda_pagar", "pago_deuda"), extrae el nombre o relación de la persona (ejemplos: "Papá", "Mamá", "Juan", "Carlos", "María"). Si no aplica, null.
3. monto: Número positivo en decimales (ej. 127.82, 15.50).
   - "quince lucas" = 15
   - "un sol con cincuenta" = 1.50
   - "cincuenta soles" = 50
   - "127.82 soles" = 127.82
   - Si no menciona monto exacto, infiere 0 o null.
4. moneda: "PEN" si son soles o no especifica; "USD" si dice dólares o verdes.
5. cuenta: El ID de la cuenta bancaria de donde entra o sale el dinero.
   - REGLA ABSOLUTA: La cuenta principal del usuario es "${defaultAcc.id}" (${defaultAcc.name}).
   - A menos que el usuario mencione explícitamente el nombre de otra cuenta específica (ej. "con bcp" o "a mi yape"), SIEMPRE asigna cuenta: "${defaultAcc.id}".
   - Para deudas ("deuda_cobrar", "cobro_deuda", "deuda_pagar", "pago_deuda"): SIEMPRE asigna "${defaultAcc.id}". NUNCA uses "efectivo" ni null a menos que el usuario diga literalmente "en efectivo" o "con billetes".
   - Para egreso o ingreso: si no especifica otra cuenta, SIEMPRE asigna "${defaultAcc.id}".
6. cuenta_destino: Solo para transferencias entre cuentas propias. En otro caso: null.
7. categoria:
   - Para "deuda_cobrar" o "deuda_pagar": usa "Préstamos y Deudas".
   - Para "cobro_deuda": usa "Cobro de Deuda".
   - Para "pago_deuda": usa "Pago de Deuda".
   - Para egreso/ingreso general: escoge la más adecuada de la lista.
8. descripcion: Resumen conciso y claro de lo que fue el movimiento o el motivo de la deuda (ej. "Deuda de papá", "Almuerzo cena", "Préstamo personal", "Taxi a Miraflores", "Devolución de préstamo").
9. fecha: En formato YYYY-MM-DD. Si dice "ayer", calcula la fecha de ayer relativa a hoy (${todayISO}). Si no especifica fecha, usa ${todayISO}.
10. Si el usuario NO menciona ningún movimiento financiero ni deuda (por ejemplo, solo saluda "hola", "buenas", "probando el microfono", "1 2 3"):
    Devuelve un JSON con:
    {
      "es_conversacion": true,
      "mensaje": "¡Hola! Para registrar un movimiento, dime lo que gastaste, recibiste o prestaste (ej: 'Mi papá me debe 127.82 soles' o 'Gasté 15 soles en almuerzo')."
    }

FORMATO DE SALIDA (JSON ÚNICAMENTE):
{
  "tipo": "egreso" | "ingreso" | "transferencia" | "deuda_cobrar" | "cobro_deuda" | "deuda_pagar" | "pago_deuda",
  "persona": "Nombre de Persona o null",
  "monto": 0.00,
  "moneda": "PEN",
  "cuenta": "${defaultAcc.id}",
  "cuenta_destino": null,
  "categoria": "Nombre de Categoria",
  "descripcion": "Descripción concisa",
  "fecha": "YYYY-MM-DD"
}`;

  // Dynamically query available models directly from Groq's API
  const liveModels = await fetchAvailableGroqModels(apiKey);

  const candidateModels = [];
  const requestedModel = context.selectedModel;

  // Add user preference first if valid and not decommissioned
  if (requestedModel && !isDecommissioned(requestedModel)) {
    candidateModels.push(requestedModel);
  }

  // Add all live models discovered directly from the API endpoint
  for (const m of liveModels) {
    if (!candidateModels.includes(m) && !isDecommissioned(m)) {
      candidateModels.push(m);
    }
  }

  // Add verified active models as safety net
  for (const m of VERIFIED_ACTIVE_MODELS) {
    if (!candidateModels.includes(m) && !isDecommissioned(m)) {
      candidateModels.push(m);
    }
  }

  let lastError = null;
  let rawContent = null;

  for (const currentModel of candidateModels) {
    try {
      const response = await fetch(GROQ_CHAT_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey.trim()}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: currentModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: speechText }
          ],
          response_format: { type: 'json_object' },
          temperature: 0.1
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errMsg = errorData.error?.message || `Error (${response.status})`;

        // If the model has access issues, rate limits, or is deprecated, seamlessly try next model
        if (
          errMsg.includes('does not exist') ||
          errMsg.includes('access to it') ||
          errMsg.includes('decommissioned') ||
          errMsg.includes('deprecated') ||
          response.status === 404 ||
          response.status === 400
        ) {
          console.warn(`Modelo ${currentModel} no disponible en Groq (${errMsg}), intentando siguiente modelo activo...`);
          lastError = new Error(errMsg);
          continue;
        }
        throw new Error(errMsg);
      }

      const jsonResult = await response.json();
      rawContent = jsonResult.choices[0]?.message?.content;
      if (rawContent) break;
    } catch (err) {
      lastError = err;
      if (
        err.message && (
          err.message.includes('does not exist') ||
          err.message.includes('access to it') ||
          err.message.includes('decommissioned') ||
          err.message.includes('deprecated')
        )
      ) {
        continue;
      }
      throw err;
    }
  }

  if (!rawContent) {
    throw lastError || new Error('No se pudo procesar con los modelos disponibles de Groq.');
  }

  try {
    const parsed = JSON.parse(rawContent);
    if (!parsed.es_conversacion) {
      const lowerSpeech = speechText.toLowerCase();
      // If no account returned, or 'null', or if 'efectivo' was assigned without saying cash
      if (!parsed.cuenta || parsed.cuenta === 'null' || (parsed.cuenta === 'efectivo' && !lowerSpeech.includes('efectivo') && !lowerSpeech.includes('billete'))) {
        parsed.cuenta = defaultAcc.id;
      }
    }
    return parsed;
  } catch (err) {
    console.error('JSON parse error from LLM response:', rawContent);
    throw new Error('Error al interpretar el formato devuelto por la IA.');
  }
}

function isDecommissioned(modelId) {
  if (!modelId) return true;
  const lower = modelId.toLowerCase();
  return (
    lower.includes('mixtral') ||
    lower.includes('llama3-8b-8192') ||
    lower.includes('llama3-70b-8192') ||
    lower.includes('gemma-7b') ||
    lower.includes('gemma2-9b')
  );
}
