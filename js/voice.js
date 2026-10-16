/**
 * Voice Module - Audio Recording, Web Audio Visualizer & Web Speech API Fallback
 */

export class VoiceManager {
  constructor() {
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.stream = null;
    this.audioContext = null;
    this.analyser = null;
    this.sourceNode = null;
    this.animationFrameId = null;
    this.isRecording = false;

    // Speech Recognition fallback (if available in browser)
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.hasWebSpeech = !!SpeechRecognition;
    this.recognition = SpeechRecognition ? new SpeechRecognition() : null;

    if (this.recognition) {
      this.recognition.lang = 'es-PE'; // Spanish (Peru / Latin America)
      this.recognition.continuous = false;
      this.recognition.interimResults = true;
    }
  }

  /**
   * Start recording audio with MediaRecorder and setup canvas visualizer
   */
  async startRecording(canvasElement, onSpeechUpdate) {
    if (this.isRecording) return;

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      // Mobile haptic feedback
      if ('vibrate' in navigator) navigator.vibrate(40);

      this.audioChunks = [];
      
      // Determine optimal mimeType supported by browser / iOS
      let mimeType = 'audio/webm';
      if (!MediaRecorder.isTypeSupported('audio/webm')) {
        if (MediaRecorder.isTypeSupported('audio/mp4')) {
          mimeType = 'audio/mp4';
        } else if (MediaRecorder.isTypeSupported('audio/aac')) {
          mimeType = 'audio/aac';
        } else {
          mimeType = ''; // Let browser choose default
        }
      }

      this.mediaRecorder = mimeType 
        ? new MediaRecorder(this.stream, { mimeType }) 
        : new MediaRecorder(this.stream);

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };

      this.mediaRecorder.start(100); // 100ms chunks
      this.isRecording = true;

      // Setup Web Audio Analyser for live visualizer
      if (canvasElement) {
        this.setupVisualizer(canvasElement);
      }

      return true;
    } catch (err) {
      console.error('Error starting audio recording:', err);
      throw new Error('No se pudo acceder al micrófono. Por favor permite los permisos.');
    }
  }

  /**
   * Setup live frequency bar visualizer on canvas
   */
  setupVisualizer(canvas) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new AudioCtx();
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 64;

      this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);
      this.sourceNode.connect(this.analyser);

      const ctx = canvas.getContext('2d');
      const bufferLength = this.analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      const render = () => {
        if (!this.isRecording) return;
        this.animationFrameId = requestAnimationFrame(render);

        this.analyser.getByteFrequencyData(dataArray);

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const barWidth = (canvas.width / bufferLength) * 1.8;
        let x = 0;

        for (let i = 0; i < bufferLength; i++) {
          const barHeight = (dataArray[i] / 255) * canvas.height * 0.9;

          // Minimalist matte visualizer bars (dark charcoal for light mode)
          ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
          ctx.beginPath();
          ctx.roundRect(x, (canvas.height - barHeight) / 2, Math.max(2, barWidth - 3), Math.max(3, barHeight), 2);
          ctx.fill();

          x += barWidth;
        }
      };

      render();
    } catch (e) {
      console.warn('Canvas visualizer setup failed, falling back to basic display:', e);
    }
  }

  /**
   * Stop recording and return audio blob
   */
  stopRecording() {
    return new Promise((resolve) => {
      if (!this.isRecording || !this.mediaRecorder) {
        resolve(null);
        return;
      }

      this.isRecording = false;

      // Stop visualizer
      if (this.animationFrameId) {
        cancelAnimationFrame(this.animationFrameId);
      }
      if (this.audioContext && this.audioContext.state !== 'closed') {
        this.audioContext.close().catch(() => {});
      }

      this.mediaRecorder.onstop = () => {
        const mimeType = this.mediaRecorder.mimeType || 'audio/webm';
        const blob = new Blob(this.audioChunks, { type: mimeType });

        // Stop all audio tracks
        if (this.stream) {
          this.stream.getTracks().forEach(t => t.stop());
        }

        // Haptic feedback
        if ('vibrate' in navigator) navigator.vibrate([30, 50, 30]);

        resolve(blob);
      };

      this.mediaRecorder.stop();
    });
  }

  /**
   * Web Speech API Native Streaming alternative
   */
  startWebSpeechRecognition(onInterim, onFinal, onError) {
    if (!this.recognition) {
      if (onError) onError('Tu navegador no soporta Web Speech nativo. Se usará grabación de audio con Whisper.');
      return false;
    }

    this.recognition.onresult = (event) => {
      let interim = '';
      let final = '';

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          final += event.results[i][0].transcript;
        } else {
          interim += event.results[i][0].transcript;
        }
      }

      if (onInterim && interim) onInterim(interim);
      if (onFinal && final) onFinal(final);
    };

    this.recognition.onerror = (e) => {
      console.error('Speech recognition error:', e.error);
      if (onError) onError(e.error);
    };

    try {
      this.recognition.start();
      return true;
    } catch (e) {
      console.warn('Recognition start error:', e);
      return false;
    }
  }

  stopWebSpeechRecognition() {
    if (this.recognition) {
      try { this.recognition.stop(); } catch(e) {}
    }
  }
}

export const voiceManager = new VoiceManager();
