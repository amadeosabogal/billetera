# Billetera Voz - Finanzas Personales & Control de Deudas (PWA)

Aplicación Web Progresiva (PWA) móvil minimalista para el registro y gestión de finanzas personales, gastos, ingresos y préstamos/deudas mediante comandos de voz en español con Inteligencia Artificial.

---

## Características Principales

- **Registro por Voz en Tiempo Real:** Dicta tus transacciones naturalmente (*"Gasté 18 soles en menú ejecutivo"* o *"Mi papá me debe 127.82 soles"*).
- **Procesamiento de IA:** Transcripción de audio con **Groq Whisper Large v3 Turbo** y extracción estructurada con modelos de lenguaje de producción (**OpenAI GPT-OSS 20B / LLaMA 3.3**).
- **Cuenta Principal Automática (Interbank):** Diseñada para operar por defecto con tu cuenta de Interbank sin necesidad de nombrarla en cada comando. Permite agregar otras cuentas secundarias desde el menú.
- **Módulo de Deudas y Préstamos:**
  - Control de dinero que te deben y dinero que debes.
  - Registro de cobros y amortizaciones con actualización inmediata del saldo.
- **Sincronización en la Nube con Supabase:**
  - Conexión directa mediante Anon Key.
  - Sincronización en tiempo real multidispositivo (PC, laptop y celular).
  - Modo offline-first con persistencia local.
- **Diseño Móvil Minimalista:** Tipografía **Archivo**, paleta de colores sobria, sin emojis superfluos, con micro-animaciones fluidas.
- **100% Instalable como PWA:** Agrega el acceso directo a la pantalla de inicio de tu teléfono móvil para usarla como una aplicación nativa.

---

## Tecnologías

- **Frontend:** HTML5 semántico, CSS3 Vanilla (variables, glassmorphism, responsive móvil), JavaScript ES Modules.
- **Bundler:** Vite.
- **Backend & Base de Datos:** Supabase (PostgreSQL, Realtime, Edge Functions).
- **Motor de IA:** Groq API (Whisper Large v3 Turbo + Chat Completions).

---

## Ejecución Local

1. Clonar el repositorio:
   ```bash
   git clone https://github.com/amadeosabogal/billetera.git
   cd billetera
   ```

2. Instalar dependencias:
   ```bash
   npm install
   ```

3. Configurar variables de entorno:
   Crea un archivo `.env` en la raíz con tus credenciales de Supabase:
   ```env
   VITE_SUPABASE_URL=https://tu-proyecto.supabase.co
   VITE_SUPABASE_ANON_KEY=tu-anon-key
   ```

4. Iniciar servidor de desarrollo:
   ```bash
   npm run dev
   ```
   Abre `http://localhost:5173` en tu navegador, o accede desde la IP local de tu red Wi-Fi para probar en tu teléfono.

---

## Cómo instalar en tu Celular (PWA)

1. **Despliegue con HTTPS:** Despliega el proyecto en [Vercel](https://vercel.com) o [Netlify](https://netlify.com) conectando este repositorio de GitHub.
2. Abre la URL en el navegador de tu celular:
   - **Android (Chrome):** Toca los 3 puntos del menú superior y selecciona **"Instalar aplicación"** o **"Agregar a la pantalla principal"**.
   - **iOS (Safari):** Toca el botón de Compartir (icono con flecha hacia arriba) y selecciona **"Agregar a pantalla de inicio"**.
3. ¡Listo! Tendrás el icono en tu pantalla de inicio funcionando a pantalla completa como una app nativa.
