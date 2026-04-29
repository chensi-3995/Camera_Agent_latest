import {
    computed,
    createApp,
    nextTick,
    onBeforeUnmount,
    onMounted,
    reactive,
    ref,
} from "../../vendor/vue.esm-browser.prod.js";

const DASHBOARD_API = "/api/dashboard";
const XIAOAN_STREAM_API = "/api/xiaoan/chat/stream";
const XIAOAN_TRANSCRIBE_API = "/api/xiaoan/voice/transcribe";
const XIAOAN_SPEAK_API = "/api/xiaoan/voice/speak";
const XIAOAN_AUDIO_API = "/api/xiaoan/voice/audio";
const XIAOAN_LOCAL_SPEAK_API = "/api/xiaoan/voice/local_speak";
const XIAOAN_NO_RESULT_AUDIO_API = "/api/xiaoan/voice/cached/no-result";
const XIAOAN_NO_RESULT_TEXT = "未发现相关异常记录。";
const FALLBACK_LOGO = "/static/img/xiaoan-logo.png";
const SILENT_AUDIO_DATA_URL = "data:audio/wav;base64,UklGRlYAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YTIAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==";
const SPEECH_RECOGNITION_CTOR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
const WAKE_NAME_VARIANTS = ["小安", "晓安", "小案", "小岸", "小按", "小暗", "小嗯"];
const WAKE_GREETING_VARIANTS = ["您好", "你好", "嗨", "哈喽", "喂"];
const RECORDING_DEFAULTS = {
    maxDurationMs: 9000,
    initialSilenceMs: 4200,
    trailingSilenceMs: 1200,
    volumeThreshold: 0.018,
};
const PREFERRED_XIAOAN_VOICE_NAMES = [
    "Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)",
    "Microsoft Xiaoxiao - Chinese (Simplified, PRC)",
    "Microsoft Xiaoyi Online (Natural) - Chinese (Mainland)",
    "Microsoft Xiaohan Online (Natural) - Chinese (Mainland)",
    "Microsoft Xiaomeng Online (Natural) - Chinese (Mainland)",
];
const PREFERRED_XIAOAN_VOICE_PATTERNS = [
    /xiaoxiao/i,
    /xiaoyi/i,
    /xiaohan/i,
    /xiaomeng/i,
    /female/i,
];

function requestJson(url, options = {}) {
    return fetch(url, options).then(async (response) => {
        const contentType = response.headers.get("content-type") || "";
        const payload = contentType.includes("application/json")
            ? await response.json()
            : { message: await response.text() };
        if (!response.ok) {
            throw new Error(payload.message || "请求失败");
        }
        return payload;
    });
}

function formatClock() {
    return new Date().toLocaleString("zh-CN", {
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    }).replace(/\//g, "-");
}

function formatReferenceTime(value) {
    const text = String(value || "").trim();
    if (!text) {
        return "--:--:--";
    }
    if (text.length >= 19) {
        return text.slice(11, 19);
    }
    return text.slice(-8);
}

function normalizeText(value) {
    return String(value || "").replace(/[，。！？、,\s]/g, "").trim();
}

function escapeRegex(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pickSupportedMimeType() {
    if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
        return "";
    }
    const candidates = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4",
        "audio/ogg;codecs=opus",
    ];
    return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function parseWakeTranscript(transcript, wakePhrase) {
    const rawText = String(transcript || "").trim();
    const normalizedTranscript = normalizeText(rawText).toLowerCase();
    const wakeAliases = new Set();
    const normalizedWake = normalizeText(wakePhrase).toLowerCase();
    if (normalizedWake) {
        wakeAliases.add(normalizedWake);
    }
    WAKE_NAME_VARIANTS.forEach((name) => {
        wakeAliases.add(normalizeText(name).toLowerCase());
        WAKE_GREETING_VARIANTS.forEach((greeting) => {
            wakeAliases.add(normalizeText(`${greeting}${name}`).toLowerCase());
        });
    });

    const matchedAlias = Array.from(wakeAliases).find((alias) => alias && normalizedTranscript.includes(alias));
    if (!matchedAlias) {
        return {
            matched: false,
            rawText,
            question: rawText,
        };
    }

    const wakePattern = new RegExp(
        `(?:${WAKE_GREETING_VARIANTS.map(escapeRegex).join("|")})?[，,\\s]*`
        + `(?:${WAKE_NAME_VARIANTS.map(escapeRegex).join("|")})`,
        "i",
    );
    const matchedSegment = rawText.match(wakePattern);
    let stripped = rawText;
    if (matchedSegment && typeof matchedSegment.index === "number") {
        stripped = rawText.slice(matchedSegment.index + matchedSegment[0].length);
    } else if (wakePhrase) {
        stripped = rawText.replace(new RegExp(escapeRegex(wakePhrase), "i"), "");
    }
    stripped = stripped.replace(/^[，,。！？!?:：;；\s]+/, "").trim();

    return {
        matched: true,
        rawText,
        question: stripped,
    };
}

function buildSvgTrend(values, width = 480, height = 140) {
    const safeValues = Array.isArray(values) && values.length ? values : new Array(24).fill(0);
    const maxValue = Math.max(...safeValues, 1);
    const left = 14;
    const right = width - 14;
    const top = 18;
    const bottom = height - 18;
    const stepX = safeValues.length > 1 ? (right - left) / (safeValues.length - 1) : 0;

    const points = safeValues.map((value, index) => {
        const x = left + index * stepX;
        const ratio = value / maxValue;
        const y = bottom - (bottom - top) * ratio;
        return { x, y };
    });

    const linePath = points
        .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
        .join(" ");
    const areaPath = `${linePath} L ${right.toFixed(2)} ${bottom.toFixed(2)} L ${left.toFixed(2)} ${bottom.toFixed(2)} Z`;

    const gridLines = [0.25, 0.5, 0.75].map((ratio) => {
        const y = bottom - (bottom - top) * ratio;
        return { y: y.toFixed(2) };
    });

    return { linePath, areaPath, gridLines };
}

function riskPillClass(level) {
    if (level === "High") {
        return "pill pill--high";
    }
    if (level === "Medium") {
        return "pill pill--medium";
    }
    return "pill pill--low";
}

async function streamSsePost(url, payload, handlers) {
    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
    });
    if (!response.ok || !response.body) {
        throw new Error("流式请求失败");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let lastEvent = null;

    while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

        let boundaryIndex = buffer.indexOf("\n\n");
        while (boundaryIndex >= 0) {
            const block = buffer.slice(0, boundaryIndex);
            buffer = buffer.slice(boundaryIndex + 2);
            const dataLine = block
                .split("\n")
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trim())
                .join("");
            if (dataLine) {
                const parsed = JSON.parse(dataLine);
                lastEvent = parsed;
                if (handlers?.onEvent) {
                    await handlers.onEvent(parsed);
                }
                if (parsed?.type === "done" || parsed?.type === "error") {
                    try {
                        await reader.cancel();
                    } catch (error) {
                        void error;
                    }
                    return lastEvent;
                }
            }
            boundaryIndex = buffer.indexOf("\n\n");
        }

        if (done) {
            break;
        }
    }

    return lastEvent;
}

createApp({
    setup() {
        const loading = ref(true);
        const error = ref("");
        const clockText = ref(formatClock());
        const dashboard = ref(null);
        const audioPlayerRef = ref(null);
        const transientAudioUrl = ref("");
        const cameraErrors = reactive({});
        const refreshTimer = ref(null);
        const clockTimer = ref(null);

        const assistant = reactive({
            greeting: "您好，我是值班小安。有什么可以帮您？",
            wakePhrase: "您好，小安",
            wakeReply: "我在",
            placeholder: "例如：昨天有没有出现一个黑色衣服的人？",
            mode: "idle",
            modeLabel: "等待唤醒",
            input: "",
            transcriptVisible: true,
            question: "",
            answer: "",
            speechText: "",
            references: [],
            history: [],
            busy: false,
            recording: false,
            greetingPlayed: false,
            lastHint: "语音唤醒词：您好，小安",
            error: "",
            recognition: null,
            recognitionTranscript: "",
            recorder: null,
            recordChunks: [],
            mediaStream: null,
            audioContext: null,
            analyser: null,
            analyserSource: null,
            analyserFrameId: 0,
            lastVoiceAt: 0,
            recordStartedAt: 0,
            voiceDetected: false,
            followupArmed: false,
            autoResumeAfterSpeak: false,
            audioUnlocked: false,
            preferBrowserAsr: false,
            browserAsrSupported: Boolean(SPEECH_RECOGNITION_CTOR),
            preferBrowserTts: typeof window !== "undefined" && "speechSynthesis" in window,
            ttsRequestSeq: 0,
            noResultAudioUrl: XIAOAN_NO_RESULT_AUDIO_API,
        });

        const primaryCamera = computed(() => (dashboard.value?.cameras || [])[0] || null);
        const secondaryCamera = computed(() => (dashboard.value?.cameras || [])[1] || null);
        const latestAlerts = computed(() => dashboard.value?.recent_alerts || []);
        const latestLogs = computed(() => (dashboard.value?.logs || []).slice(0, 4));
        const summaryCard = computed(() => dashboard.value?.summary || {});
        const structure = computed(() => dashboard.value?.structure || { risk_distribution: [], anomaly_distribution: [] });
        const hourlyTrendSvg = computed(() => {
            const values = (dashboard.value?.trends?.hourly || []).map((item) => Number(item.count || 0));
            return buildSvgTrend(values);
        });
        const weeklyTrend = computed(() => dashboard.value?.trends?.weekly || []);
        const weeklyMax = computed(() => Math.max(...weeklyTrend.value.map((item) => Number(item.total || 0)), 1));
        const donutStyle = computed(() => {
            const slices = structure.value?.risk_distribution || [];
            if (!slices.length) {
                return { background: "conic-gradient(#29d3ff 0 100%)" };
            }
            let start = 0;
            const parts = slices.map((slice) => {
                const end = start + Number(slice.ratio || 0);
                const segment = `${slice.color} ${start}% ${Math.min(end, 100)}%`;
                start = end;
                return segment;
            });
            if (start < 100) {
                parts.push(`rgba(255,255,255,0.08) ${start}% 100%`);
            }
            return { background: `conic-gradient(${parts.join(", ")})` };
        });

        function setAssistantMode(mode, label) {
            assistant.mode = mode;
            assistant.modeLabel = label;
        }

        function markCameraError(cameraId) {
            cameraErrors[cameraId] = true;
        }

        function clearCameraError(cameraId) {
            cameraErrors[cameraId] = false;
        }

        async function loadDashboard() {
            try {
                const payload = await requestJson(DASHBOARD_API);
                dashboard.value = payload;
                assistant.greeting = payload.assistant?.greeting || assistant.greeting;
                assistant.wakePhrase = payload.assistant?.wake_phrase || assistant.wakePhrase;
                assistant.wakeReply = payload.assistant?.wake_ack || assistant.wakeReply;
                assistant.placeholder = payload.assistant?.placeholder || assistant.placeholder;
                assistant.noResultAudioUrl = payload.assistant?.no_result_audio_url || assistant.noResultAudioUrl;
                if (!assistant.answer) {
                    assistant.answer = assistant.greeting;
                }
                error.value = "";
            } catch (err) {
                error.value = err.message || "大屏数据加载失败";
            } finally {
                loading.value = false;
            }
        }

        function cleanupRecorder() {
            if (assistant.analyserFrameId) {
                window.cancelAnimationFrame(assistant.analyserFrameId);
                assistant.analyserFrameId = 0;
            }
            if (assistant.analyserSource) {
                try {
                    assistant.analyserSource.disconnect();
                } catch (error) {
                    void error;
                }
                assistant.analyserSource = null;
            }
            assistant.analyser = null;
            assistant.voiceDetected = false;
            assistant.lastVoiceAt = 0;
            assistant.recordStartedAt = 0;
            if (assistant.audioContext) {
                assistant.audioContext.close().catch(() => {});
                assistant.audioContext = null;
            }
            if (assistant.mediaStream) {
                assistant.mediaStream.getTracks().forEach((track) => track.stop());
                assistant.mediaStream = null;
            }
            assistant.recorder = null;
            assistant.recordChunks = [];
            assistant.recording = false;
        }

        function stopRecorderSafely() {
            if (!assistant.recorder || assistant.recorder.state === "inactive") {
                return;
            }
            assistant.recorder.stop();
        }

        let activeAudioPlayer = null;
        let speechPlaybackContext = null;
        let activeBufferSource = null;
        let activeGainNode = null;

        function stopActiveAudioPlayback() {
            if (activeBufferSource) {
                try {
                    activeBufferSource.onended = null;
                    activeBufferSource.stop(0);
                } catch (error) {
                    void error;
                }
                try {
                    activeBufferSource.disconnect();
                } catch (error) {
                    void error;
                }
                activeBufferSource = null;
            }
            if (activeGainNode) {
                try {
                    activeGainNode.disconnect();
                } catch (error) {
                    void error;
                }
                activeGainNode = null;
            }
            if (!activeAudioPlayer) {
                return;
            }
            try {
                activeAudioPlayer.pause();
                activeAudioPlayer.src = "";
            } catch (error) {
                void error;
            }
            activeAudioPlayer = null;
        }

        async function ensureSpeechPlaybackContext() {
            if (typeof window === "undefined") {
                return null;
            }
            const AudioContextCtor = window.AudioContext || window.webkitAudioContext || null;
            if (!AudioContextCtor) {
                return null;
            }
            if (!speechPlaybackContext || speechPlaybackContext.state === "closed") {
                speechPlaybackContext = new AudioContextCtor();
            }
            if (speechPlaybackContext.state === "suspended") {
                await speechPlaybackContext.resume();
            }
            return speechPlaybackContext;
        }

        function scheduleFollowupRecording() {
            if (!assistant.followupArmed || assistant.recording || assistant.busy) {
                return;
            }
            window.setTimeout(async () => {
                if (!assistant.followupArmed || assistant.recording || assistant.busy) {
                    return;
                }
                try {
                    await startVoiceCapture({ followup: true, requireWake: false });
                } catch (err) {
                    assistant.followupArmed = false;
                    assistant.autoResumeAfterSpeak = false;
                    assistant.lastHint = `唤醒后监听失败：${err.message || "unknown"}`;
                    setAssistantMode("idle", "等待唤醒");
                }
            }, 180);
        }

function finishSpeaking() {
            stopActiveAudioPlayback();
            if (assistant.autoResumeAfterSpeak) {
                assistant.autoResumeAfterSpeak = false;
                scheduleFollowupRecording();
                return;
            }
            assistant.lastHint = "语音播报完成。";
            if (!assistant.busy && !assistant.recording) {
                setAssistantMode("idle", "等待唤醒");
            }
        }

        async function loadSpeechVoices(timeoutMs = 1200) {
            if (typeof window === "undefined" || !window.speechSynthesis) {
                return [];
            }

            const initialVoices = window.speechSynthesis.getVoices() || [];
            if (initialVoices.length) {
                return initialVoices;
            }

            return await new Promise((resolve) => {
                let settled = false;
                const finalize = (voices) => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    window.speechSynthesis.onvoiceschanged = null;
                    resolve(Array.isArray(voices) ? voices : []);
                };

                const timer = window.setTimeout(() => {
                    finalize(window.speechSynthesis.getVoices() || []);
                }, timeoutMs);

                window.speechSynthesis.onvoiceschanged = () => {
                    window.clearTimeout(timer);
                    finalize(window.speechSynthesis.getVoices() || []);
                };
            });
        }

        async function selectChineseVoice() {
            const voices = await loadSpeechVoices();
            if (!voices.length) {
                return null;
            }

            for (const preferredName of PREFERRED_XIAOAN_VOICE_NAMES) {
                const matched = voices.find((voice) =>
                    String(voice.name || "").toLowerCase().includes(preferredName.toLowerCase())
                );
                if (matched) {
                    return matched;
                }
            }

            for (const pattern of PREFERRED_XIAOAN_VOICE_PATTERNS) {
                const matched = voices.find((voice) =>
                    pattern.test(`${voice.name || ""} ${voice.lang || ""}`)
                );
                if (matched) {
                    return matched;
                }
            }

            return null;
        }

        async function speakWithBrowser(text, { soft = false } = {}) {
            const cleanText = String(text || "").trim();
            if (!cleanText || !assistant.preferBrowserTts || !window.speechSynthesis) {
                return false;
            }

            try {
                window.speechSynthesis.cancel();
                const utterance = new SpeechSynthesisUtterance(cleanText);
                const voice = await selectChineseVoice();
                if (!voice) {
                    return false;
                }
                utterance.voice = voice;
                utterance.lang = voice.lang || "zh-CN";
                utterance.rate = 1.16;
                utterance.pitch = 1.06;
                utterance.volume = 1.0;

                await new Promise((resolve, reject) => {
                    let finished = false;

                    utterance.onstart = () => {
                        setAssistantMode("speaking", "语音播报中");
                    };
                    utterance.onend = () => {
                        if (finished) {
                            return;
                        }
                        finished = true;
                        finishSpeaking();
                        resolve(true);
                    };
                    utterance.onerror = (event) => {
                        if (finished) {
                            return;
                        }
                        finished = true;
                        reject(new Error(event?.error || "browser_tts_failed"));
                    };

                    window.speechSynthesis.speak(utterance);
                });
                return true;
            } catch (err) {
                if (!soft) {
                    assistant.lastHint = `浏览器语音播报失败：${err.message || "unknown"}`;
                }
                return false;
            }
        }

        function releaseTransientAudioUrl() {
            if (transientAudioUrl.value && transientAudioUrl.value.startsWith("blob:")) {
                URL.revokeObjectURL(transientAudioUrl.value);
            }
            transientAudioUrl.value = "";
        }

        async function requestAudioBlob(text, { useCache = true, timeoutMs = 45000 } = {}) {
            const controller = new AbortController();
            const timerId = window.setTimeout(() => controller.abort("timeout"), timeoutMs);
            try {
                const response = await fetch(XIAOAN_AUDIO_API, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        text,
                        use_cache: useCache,
                    }),
                    signal: controller.signal,
                });
                if (!response.ok) {
                    let detail = `${response.status}`;
                    try {
                        const payload = await response.json();
                        detail = payload.message || detail;
                    } catch (error) {
                        void error;
                    }
                    throw new Error(`语音接口失败：${detail}`);
                }
                const blob = await response.blob();
                if (!(blob instanceof Blob) || blob.size <= 0) {
                    throw new Error("语音接口未返回有效音频");
                }
                return blob;
            } catch (err) {
                if (err?.name === "AbortError") {
                    throw new Error("语音接口超时");
                }
                throw err;
            } finally {
                window.clearTimeout(timerId);
            }
        }

async function playAudio(url, soft = false, { cacheBust = true } = {}) {
            if (!url) {
                return false;
            }
            stopActiveAudioPlayback();
            const player = audioPlayerRef.value || new Audio();
            activeAudioPlayer = player;
            player.src = cacheBust && !String(url).startsWith("blob:")
                ? `${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`
                : url;
            player.muted = false;
            player.volume = 1.0;
            player.preload = "auto";
            try {
                setAssistantMode("speaking", "语音播报中");
                await new Promise((resolve, reject) => {
                    let settled = false;
                    let playbackStarted = false;
                    const clearStartWatch = () => {
                        player.removeEventListener("playing", handlePlaying);
                        window.clearTimeout(timeoutId);
                    };
                    const cleanup = () => {
                        clearStartWatch();
                        player.removeEventListener("ended", handleEnded);
                        player.removeEventListener("error", handleError);
                    };
                    const finish = (fn) => {
                        if (settled) {
                            return;
                        }
                        settled = true;
                        cleanup();
                        fn();
                    };
                    const handlePlaying = () => {
                        playbackStarted = true;
                        clearStartWatch();
                        resolve(true);
                    };
                    const handleEnded = () => {
                        cleanup();
                        finishSpeaking();
                    };
                    const handleError = () => {
                        const playbackError = new Error("audio_playback_failed");
                        if (playbackStarted) {
                            cleanup();
                            if (!soft) {
                                assistant.lastHint = "语音播放中断，请重试。";
                            }
                            finishSpeaking();
                            return;
                        }
                        finish(() => reject(playbackError));
                    };
                    const timeoutId = window.setTimeout(() => {
                        finish(() => reject(new Error("audio_playback_timeout")));
                    }, 5000);

                    player.addEventListener("playing", handlePlaying, { once: true });
                    player.addEventListener("ended", handleEnded, { once: true });
                    player.addEventListener("error", handleError, { once: true });

                    const playPromise = player.play();
                    if (playPromise && typeof playPromise.then === "function") {
                        playPromise.catch((err) => {
                            finish(() => reject(err instanceof Error ? err : new Error("audio_playback_blocked")));
                        });
                    }
                });
                return true;
            } catch (err) {
                stopActiveAudioPlayback();
                if (!soft) {
                    const message = String(err?.message || "");
                    assistant.lastHint = message === "audio_playback_timeout"
                        ? "音频已生成，但浏览器未开始播放，请点击页面后重试。"
                        : "浏览器拦截了自动播放，请点击页面后重试。";
                }
                return false;
            }
        }

        async function playAudioBlobWithWebAudio(blob, soft = false) {
            if (!(blob instanceof Blob) || blob.size <= 0) {
                return false;
            }
            try {
                const playbackContext = await ensureSpeechPlaybackContext();
                if (!playbackContext) {
                    return false;
                }
                if (playbackContext.state !== "running") {
                    return false;
                }

                const arrayBuffer = await blob.arrayBuffer();
                const audioBuffer = await playbackContext.decodeAudioData(arrayBuffer.slice(0));
                stopActiveAudioPlayback();

                const source = playbackContext.createBufferSource();
                const gainNode = playbackContext.createGain();
                gainNode.gain.value = 1.0;
                source.buffer = audioBuffer;
                source.connect(gainNode);
                gainNode.connect(playbackContext.destination);

                activeBufferSource = source;
                activeGainNode = gainNode;
                setAssistantMode("speaking", "语音播报中");

                source.onended = () => {
                    try {
                        source.disconnect();
                    } catch (error) {
                        void error;
                    }
                    try {
                        gainNode.disconnect();
                    } catch (error) {
                        void error;
                    }
                    if (activeBufferSource === source) {
                        activeBufferSource = null;
                    }
                    if (activeGainNode === gainNode) {
                        activeGainNode = null;
                    }
                    finishSpeaking();
                };
                source.start(0);
                return true;
            } catch (err) {
                if (!soft) {
                    assistant.lastHint = `WebAudio 播放失败：${err.message || "unknown"}`;
                }
                return false;
            }
        }

        async function playAudioBlob(blob, soft = false) {
            if (!(blob instanceof Blob) || blob.size <= 0) {
                return false;
            }
            const webAudioPlayed = await playAudioBlobWithWebAudio(blob, soft);
            if (webAudioPlayed) {
                return true;
            }
            releaseTransientAudioUrl();
            transientAudioUrl.value = URL.createObjectURL(blob);
            return await playAudio(transientAudioUrl.value, soft, { cacheBust: false });
        }

        async function unlockAudioPlayback() {
            if (assistant.audioUnlocked) {
                return assistant.audioUnlocked;
            }
            try {
                const playbackContext = await ensureSpeechPlaybackContext();
                if (playbackContext && playbackContext.state === "suspended") {
                    await playbackContext.resume();
                }
                const player = new Audio(SILENT_AUDIO_DATA_URL);
                player.muted = true;
                await player.play();
                player.pause();
                player.src = "";
                assistant.audioUnlocked = true;
                return true;
            } catch (error) {
                return false;
            }
        }

        async function fetchAudioBlobByUrl(url, { timeoutMs = 4000 } = {}) {
            const controller = new AbortController();
            const timerId = window.setTimeout(() => controller.abort("timeout"), timeoutMs);
            try {
                const response = await fetch(url, {
                    method: "GET",
                    signal: controller.signal,
                    cache: "force-cache",
                });
                if (!response.ok) {
                    throw new Error(`audio_fetch_failed:${response.status}`);
                }
                const blob = await response.blob();
                if (!(blob instanceof Blob) || blob.size <= 0) {
                    throw new Error("audio_fetch_empty");
                }
                return blob;
            } catch (err) {
                if (err?.name === "AbortError") {
                    throw new Error("audio_fetch_timeout");
                }
                throw err;
            } finally {
                window.clearTimeout(timerId);
            }
        }

        function estimateSpeechDurationMs(text) {
            const cleanText = String(text || "").trim();
            const chineseChars = (cleanText.match(/[\u4e00-\u9fa5]/g) || []).length;
            const otherChars = Math.max(cleanText.length - chineseChars, 0);
            return Math.min(Math.max((chineseChars * 220) + (otherChars * 90) + 900, 2200), 16000);
        }

        async function speakWithLocalSpeaker(text, { soft = false } = {}) {
            const cleanText = String(text || "").trim();
            if (!cleanText) {
                return false;
            }
            try {
                const response = await fetch(XIAOAN_LOCAL_SPEAK_API, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({ text: cleanText }),
                });
                if (!response.ok) {
                    let detail = `${response.status}`;
                    try {
                        const payload = await response.json();
                        detail = payload.message || detail;
                    } catch (error) {
                        void error;
                    }
                    throw new Error(detail);
                }
                setAssistantMode("speaking", "语音播报中");
                const requestSeq = assistant.ttsRequestSeq;
                window.setTimeout(() => {
                    if (requestSeq === assistant.ttsRequestSeq && !assistant.recording) {
                        finishSpeaking();
                    }
                }, estimateSpeechDurationMs(cleanText));
                return true;
            } catch (err) {
                if (!soft) {
                    assistant.lastHint = `本机语音播报失败：${err.message || "unknown"}`;
                }
                return false;
            }
        }

        async function synthesizeAndPlay(text, { soft = false, audioUrl = "", preferBackend = false, forceRefresh = false } = {}) {
            if (!String(text || "").trim()) {
                return false;
            }
            const requestSeq = ++assistant.ttsRequestSeq;
            const cleanText = String(text || "").trim();
            const useNoResultFastPath = normalizeText(cleanText) === normalizeText(XIAOAN_NO_RESULT_TEXT);
            const noResultAudioUrl = String(assistant.noResultAudioUrl || XIAOAN_NO_RESULT_AUDIO_API).trim();

            if (useNoResultFastPath && noResultAudioUrl && !forceRefresh) {
                try {
                    setAssistantMode("speaking", "正在播放语音");
                    const cachedBlob = await fetchAudioBlobByUrl(noResultAudioUrl, { timeoutMs: 5000 });
                    const cachedPlayed = await playAudioBlob(cachedBlob, true);
                    if (requestSeq !== assistant.ttsRequestSeq) {
                        return false;
                    }
                    if (cachedPlayed) {
                        return true;
                    }
                } catch (err) {
                    if (!soft) {
                        assistant.lastHint = `缓存语音播放失败：${err.message || "unknown"}`;
                    }
                }
            }

            try {
                setAssistantMode("speaking", "正在合成语音");
                const generatedBlob = await requestAudioBlob(cleanText, {
                    useCache: !forceRefresh,
                    timeoutMs: 12000,
                });
                if (requestSeq !== assistant.ttsRequestSeq) {
                    return false;
                }
                const backendPlayed = await playAudioBlob(generatedBlob, true);
                if (backendPlayed) {
                    return true;
                }
            } catch (err) {
                if (requestSeq !== assistant.ttsRequestSeq) {
                    return false;
                }
                if (!soft) {
                    assistant.lastHint = `MOSS 语音合成失败：${err.message || "unknown"}`;
                }
            }

            const browserPlayed = await speakWithBrowser(cleanText, { soft: true });
            if (requestSeq !== assistant.ttsRequestSeq) {
                return false;
            }
            if (browserPlayed) {
                return true;
            }

            const localSpeakerStarted = await speakWithLocalSpeaker(cleanText, { soft: true });
            if (requestSeq !== assistant.ttsRequestSeq) {
                return false;
            }
            if (localSpeakerStarted) {
                return true;
            }

            if (requestSeq !== assistant.ttsRequestSeq) {
                return false;
            }
            if (!soft) {
                assistant.lastHint = preferBackend
                    ? "后端 MOSS 音频、浏览器语音和本机扬声器播报都失败了。"
                    : "语音播报失败，请检查浏览器音量与输出设备。";
            }
            finishSpeaking();
            return false;
        }

        async function playGreeting() {
            if (assistant.greetingPlayed) {
                return;
            }
            assistant.greetingPlayed = true;
            await synthesizeAndPlay(assistant.greeting, { soft: true });
        }

        function pushHistory(role, text) {
            const cleanText = String(text || "").trim();
            if (!cleanText) {
                return;
            }
            assistant.history.push({ role, text: cleanText });
            if (assistant.history.length > 8) {
                assistant.history.splice(0, assistant.history.length - 8);
            }
        }

        async function askXiaoAn(question) {
            const cleanQuestion = String(question || "").trim();
            if (!cleanQuestion || assistant.busy) {
                return;
            }

            assistant.busy = true;
            assistant.error = "";
            assistant.transcriptVisible = true;
            assistant.question = cleanQuestion;
            assistant.answer = "";
            assistant.references = [];
            assistant.lastHint = "正在分析监控记录...";
            setAssistantMode("thinking", "正在检索与推理");

            try {
                let spokeForThisAnswer = false;
                const finalEvent = await streamSsePost(
                    XIAOAN_STREAM_API,
                    {
                        question: cleanQuestion,
                        history: assistant.history,
                    },
                    {
                        onEvent: async (event) => {
                            if (event.type === "delta") {
                                assistant.answer += String(event.text || "");
                                await nextTick();
                                return;
                            }

                            if (event.type === "done") {
                                const finalAnswer = String(event.answer || assistant.answer || "").trim() || "未发现相关异常记录。";
                                assistant.answer = finalAnswer;
                                assistant.speechText = String(event.speech_text || "").trim();
                                assistant.references = [];
                                pushHistory("user", cleanQuestion);
                                pushHistory("assistant", finalAnswer);
                                assistant.lastHint = "回答已生成，可继续追问。";
                                const eventSpeechText = String(assistant.speechText || finalAnswer).trim();
                                if (eventSpeechText) {
                                    setAssistantMode("speaking", "正在准备语音");
                                    spokeForThisAnswer = await synthesizeAndPlay(eventSpeechText, {
                                        soft: false,
                                        preferBackend: true,
                                    });
                                }
                                assistant.busy = false;
                                return;
                            }

                            if (event.type === "error") {
                                throw new Error(event.message || "问答失败");
                            }
                        },
                    },
                );
                const finalAnswer = String(finalEvent?.answer || assistant.answer || "").trim();
                const speechText = String(finalEvent?.speech_text || assistant.speechText || finalAnswer || assistant.answer).trim();
                if (!spokeForThisAnswer && speechText) {
                    setAssistantMode("speaking", "正在准备语音");
                    await synthesizeAndPlay(speechText, {
                        soft: false,
                        preferBackend: true,
                    });
                } else if (!spokeForThisAnswer) {
                    assistant.lastHint = "回答已显示，但没有可播报文本。";
                    setAssistantMode("idle", "等待唤醒");
                }
            } catch (err) {
                assistant.error = err.message || "问答失败";
                assistant.answer = "当前无法完成这次查询，请稍后重试。";
                assistant.lastHint = assistant.error;
                setAssistantMode("idle", "等待唤醒");
            } finally {
                assistant.busy = false;
            }
        }

        async function submitXiaoAnQuestion(question, { source = "text", clearInput = false, unlockAudio = true } = {}) {
            const cleanQuestion = String(question || "").trim();
            if (!cleanQuestion) {
                return false;
            }
            if (unlockAudio) {
                await unlockAudioPlayback();
            }
            if (clearInput) {
                assistant.input = "";
            }
            if (source === "voice") {
                assistant.lastHint = `已识别语音：${cleanQuestion}`;
            }
            await askXiaoAn(cleanQuestion);
            return true;
        }

        async function submitInput() {
            const question = assistant.input.trim();
            if (!question) {
                return;
            }
            await submitXiaoAnQuestion(question, {
                source: "text",
                clearInput: true,
                unlockAudio: true,
            });
        }

        async function handleVoiceTranscript(transcript, { requireWake = true } = {}) {
            const rawText = String(transcript || "").trim();
            if (!rawText) {
                assistant.lastHint = "没有识别到有效语音内容。";
                setAssistantMode("idle", "等待唤醒");
                return;
            }

            if (!requireWake) {
                assistant.followupArmed = false;
                assistant.autoResumeAfterSpeak = false;
                await submitXiaoAnQuestion(rawText, {
                    source: "voice",
                    unlockAudio: true,
                });
                return;
            }

            if (assistant.followupArmed) {
                assistant.followupArmed = false;
                assistant.autoResumeAfterSpeak = false;
                await submitXiaoAnQuestion(rawText, {
                    source: "voice",
                    unlockAudio: true,
                });
                return;
            }

            const wakeResult = parseWakeTranscript(rawText, assistant.wakePhrase);
            if (!wakeResult.matched) {
                assistant.transcriptVisible = true;
                assistant.question = "语音唤醒";
                assistant.answer = `请先说“${assistant.wakePhrase}”，再继续提问。`;
                assistant.references = [];
                assistant.lastHint = `已识别语音：${rawText}`;
                setAssistantMode("idle", "等待唤醒");
                return;
            }

            const stripped = String(wakeResult.question || "").trim();
            if (!stripped) {
                assistant.transcriptVisible = true;
                assistant.question = wakeResult.rawText || assistant.wakePhrase;
                assistant.answer = assistant.wakeReply;
                assistant.references = [];
                assistant.followupArmed = true;
                assistant.autoResumeAfterSpeak = true;
                assistant.lastHint = "已唤醒小安，请直接说出你的问题。";
                await synthesizeAndPlay(assistant.wakeReply, { soft: false });
                return;
            }

            await submitXiaoAnQuestion(stripped, {
                source: "voice",
                unlockAudio: true,
            });
        }

        async function uploadRecordedAudio(blob, { requireWake = true } = {}) {
            setAssistantMode("thinking", "正在识别语音");
            const formData = new FormData();
            const filename = blob.type.includes("wav") ? "xiaoan.wav" : "xiaoan.webm";
            formData.append("audio", blob, filename);
            const payload = await requestJson(XIAOAN_TRANSCRIBE_API, {
                method: "POST",
                body: formData,
            });
            await handleVoiceTranscript(payload.transcript || "", { requireWake });
        }

        function stopBrowserRecognition() {
            if (!assistant.recognition) {
                return;
            }
            try {
                assistant.recognition.stop();
            } catch (error) {
                void error;
            }
        }

        async function startBrowserRecognition({ followup = false, requireWake = true } = {}) {
            if (!SPEECH_RECOGNITION_CTOR) {
                throw new Error("当前浏览器不支持原生语音识别。");
            }
            if (assistant.busy || assistant.recording) {
                return;
            }

            const recognition = new SPEECH_RECOGNITION_CTOR();
            let finalized = false;
            assistant.recognition = recognition;
            assistant.recognitionTranscript = "";
            assistant.recording = true;

            recognition.lang = "zh-CN";
            recognition.continuous = false;
            recognition.interimResults = true;
            recognition.maxAlternatives = 1;

            recognition.onresult = (event) => {
                let finalText = "";
                let interimText = "";
                for (let index = event.resultIndex; index < event.results.length; index += 1) {
                    const alternative = event.results[index]?.[0]?.transcript || "";
                    if (event.results[index].isFinal) {
                        finalText += alternative;
                    } else {
                        interimText += alternative;
                    }
                }

                const cleanFinalText = String(finalText || "").trim();
                const cleanInterimText = String(interimText || "").trim();
                if (cleanFinalText) {
                    assistant.recognitionTranscript = cleanFinalText;
                }
                if (cleanInterimText) {
                    assistant.lastHint = `正在识别：${cleanInterimText}`;
                }
            };

            recognition.onerror = (event) => {
                if (finalized) {
                    return;
                }
                finalized = true;
                assistant.recording = false;
                assistant.recognition = null;
                assistant.followupArmed = false;
                assistant.autoResumeAfterSpeak = false;

                const errorCode = String(event?.error || "");
                if (errorCode === "no-speech") {
                    assistant.lastHint = "没有识别到语音，请重试。";
                } else if (errorCode === "not-allowed" || errorCode === "service-not-allowed") {
                    assistant.lastHint = "浏览器没有麦克风权限，请先允许麦克风访问。";
                } else {
                    assistant.lastHint = `语音识别失败：${errorCode || "unknown"}`;
                }
                setAssistantMode("idle", "等待唤醒");
            };

            recognition.onend = async () => {
                if (finalized) {
                    return;
                }
                finalized = true;
                const transcript = String(assistant.recognitionTranscript || "").trim();
                assistant.recording = false;
                assistant.recognition = null;

                if (!transcript) {
                    assistant.followupArmed = false;
                    assistant.autoResumeAfterSpeak = false;
                    assistant.lastHint = "没有识别到有效语音，请重试。";
                    setAssistantMode("idle", "等待唤醒");
                    return;
                }

                try {
                    await handleVoiceTranscript(transcript, { requireWake });
                } catch (err) {
                    assistant.answer = "语音识别失败，请稍后重试。";
                    assistant.error = err.message || "语音识别失败";
                    assistant.lastHint = assistant.error;
                    assistant.followupArmed = false;
                    assistant.autoResumeAfterSpeak = false;
                    setAssistantMode("idle", "等待唤醒");
                }
            };

            recognition.start();
            const directAsk = !requireWake || followup;
            assistant.lastHint = directAsk
                ? "请直接说出你的问题。"
                : `请先说“${assistant.wakePhrase}”，再提问。`;
            setAssistantMode("listening", directAsk ? "正在听问题" : "正在监听中");
        }

        function startSilenceMonitor() {
            if (!assistant.analyser) {
                return;
            }
            const buffer = new Uint8Array(assistant.analyser.fftSize);
            const monitor = () => {
                if (!assistant.recording || !assistant.analyser) {
                    return;
                }
                assistant.analyser.getByteTimeDomainData(buffer);
                let energy = 0;
                for (let index = 0; index < buffer.length; index += 1) {
                    const normalized = (buffer[index] - 128) / 128;
                    energy += normalized * normalized;
                }
                const rms = Math.sqrt(energy / buffer.length);
                const now = performance.now();
                if (rms >= RECORDING_DEFAULTS.volumeThreshold) {
                    assistant.voiceDetected = true;
                    assistant.lastVoiceAt = now;
                }

                const elapsed = now - assistant.recordStartedAt;
                const exceededSilence = assistant.voiceDetected
                    ? (now - assistant.lastVoiceAt) >= RECORDING_DEFAULTS.trailingSilenceMs
                    : elapsed >= RECORDING_DEFAULTS.initialSilenceMs;
                if (elapsed >= RECORDING_DEFAULTS.maxDurationMs || exceededSilence) {
                    stopRecorderSafely();
                    return;
                }
                assistant.analyserFrameId = window.requestAnimationFrame(monitor);
            };
            assistant.analyserFrameId = window.requestAnimationFrame(monitor);
        }

        async function startRecordingSession({ followup = false, requireWake = true } = {}) {
            if (assistant.busy || assistant.recording) {
                return;
            }
            assistant.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            assistant.recordChunks = [];
            assistant.voiceDetected = false;
            assistant.recordStartedAt = performance.now();
            assistant.lastVoiceAt = assistant.recordStartedAt;

            const mimeType = pickSupportedMimeType();
            assistant.recorder = mimeType
                ? new MediaRecorder(assistant.mediaStream, { mimeType })
                : new MediaRecorder(assistant.mediaStream);
            assistant.recorder.ondataavailable = (event) => {
                if (event.data && event.data.size > 0) {
                    assistant.recordChunks.push(event.data);
                }
            };
            assistant.recorder.onerror = () => {
                assistant.lastHint = "录音失败，请检查麦克风权限。";
                assistant.followupArmed = false;
                assistant.autoResumeAfterSpeak = false;
                cleanupRecorder();
                setAssistantMode("idle", "等待唤醒");
            };
            assistant.recorder.onstop = async () => {
                const blobType = assistant.recordChunks[0]?.type || mimeType || "audio/webm";
                const recordedBlob = new Blob(assistant.recordChunks, { type: blobType });
                cleanupRecorder();
                if (recordedBlob.size <= 0) {
                    assistant.followupArmed = false;
                    assistant.autoResumeAfterSpeak = false;
                    assistant.lastHint = "没有录到有效语音，请重试。";
                    setAssistantMode("idle", "等待唤醒");
                    return;
                }
                try {
                    await uploadRecordedAudio(recordedBlob, { requireWake });
                } catch (err) {
                    assistant.answer = "语音识别失败，请稍后重试。";
                    assistant.error = err.message || "语音识别失败";
                    assistant.lastHint = assistant.error;
                    assistant.followupArmed = false;
                    assistant.autoResumeAfterSpeak = false;
                    setAssistantMode("idle", "等待唤醒");
                }
            };

            const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
            if (AudioContextCtor) {
                assistant.audioContext = new AudioContextCtor();
                assistant.analyser = assistant.audioContext.createAnalyser();
                assistant.analyser.fftSize = 2048;
                assistant.analyserSource = assistant.audioContext.createMediaStreamSource(assistant.mediaStream);
                assistant.analyserSource.connect(assistant.analyser);
                startSilenceMonitor();
            }

            assistant.recorder.start();
            assistant.recording = true;
            const directAsk = !requireWake || followup;
            assistant.lastHint = directAsk
                ? "请直接说出你的问题。"
                : `请先说“${assistant.wakePhrase}”，再提问。`;
            setAssistantMode("listening", directAsk ? "正在听问题" : "正在监听中");
        }

        async function startVoiceCapture({ followup = false, requireWake = true } = {}) {
            try {
                await startRecordingSession({ followup, requireWake });
                return;
            } catch (recordingError) {
                if (assistant.browserAsrSupported) {
                    assistant.lastHint = "后端语音识别链路不可用，正在切换到浏览器识别。";
                    await startBrowserRecognition({ followup, requireWake });
                    return;
                }
                throw recordingError;
            }
        }

        async function toggleRecording() {
            if (assistant.busy) {
                return;
            }
            if (assistant.recording) {
                if (assistant.recognition) {
                    stopBrowserRecognition();
                    return;
                }
                if (assistant.recorder) {
                    stopRecorderSafely();
                    return;
                }
                return;
            }

            assistant.followupArmed = false;
            assistant.autoResumeAfterSpeak = false;
            try {
                await unlockAudioPlayback();
                await startVoiceCapture({ followup: false, requireWake: false });
            } catch (err) {
                assistant.lastHint = "无法访问麦克风，请检查浏览器权限。";
                setAssistantMode("idle", "等待唤醒");
            }
        }

        function closeTranscript() {
            assistant.transcriptVisible = false;
        }

        function openTranscript() {
            assistant.transcriptVisible = true;
        }

        function retryDashboard() {
            loading.value = true;
            error.value = "";
            loadDashboard();
        }

        function isHighLog(log) {
            const text = `${log?.category || ""} ${log?.message || ""}`.toLowerCase();
            return text.includes("高危") || text.includes("high") || text.includes("告警") || text.includes("失败");
        }

        onMounted(async () => {
            await loadDashboard();
            if (audioPlayerRef.value) {
                audioPlayerRef.value.onended = () => {
                    finishSpeaking();
                };
            }
            if (typeof window !== "undefined" && window.speechSynthesis) {
                window.speechSynthesis.getVoices();
                window.speechSynthesis.onvoiceschanged = () => {
                    window.speechSynthesis.getVoices();
                };
            }
            clockTimer.value = window.setInterval(() => {
                clockText.value = formatClock();
            }, 1000);
            refreshTimer.value = window.setInterval(loadDashboard, 15000);
            setTimeout(() => {
                playGreeting();
            }, 800);
        });

        onBeforeUnmount(() => {
            releaseTransientAudioUrl();
            stopActiveAudioPlayback();
            if (clockTimer.value) {
                window.clearInterval(clockTimer.value);
            }
            if (refreshTimer.value) {
                window.clearInterval(refreshTimer.value);
            }
            stopBrowserRecognition();
            if (typeof window !== "undefined" && window.speechSynthesis) {
                window.speechSynthesis.cancel();
            }
            cleanupRecorder();
        });

        return {
            assistant,
            audioPlayerRef,
            cameraErrors,
            clockText,
            closeTranscript,
            dashboard,
            donutStyle,
            error,
            FALLBACK_LOGO,
            formatReferenceTime,
            hourlyTrendSvg,
            isHighLog,
            latestAlerts,
            latestLogs,
            loading,
            openTranscript,
            playGreeting,
            primaryCamera,
            retryDashboard,
            riskPillClass,
            secondaryCamera,
            structure,
            submitInput,
            summaryCard,
            toggleRecording,
            weeklyMax,
            weeklyTrend,
            markCameraError,
            clearCameraError,
        };
    },
    template: `
        <div v-if="loading" class="screen-loading">大屏数据加载中...</div>
        <div v-else-if="error" class="screen-error">
            <div class="screen-error__panel">
                <h2>大屏加载失败</h2>
                <p>{{ error }}</p>
                <button class="assistant-btn" @click="retryDashboard" aria-label="重试">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                        <path d="M20 12A8 8 0 1 1 16.5 5.36" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
                        <path d="M20 4V10H14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                </button>
            </div>
        </div>
        <div v-else class="screen-shell">
            <header class="screen-header">
                <div class="screen-title">
                    <div class="title-icon">
                        <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
                            <path d="M12 2L4 6.5V12.8C4 17.7 7.42 22.25 12 23C16.58 22.25 20 17.7 20 12.8V6.5L12 2Z" stroke="#23e1ff" stroke-width="1.5"/>
                            <path d="M9.5 11.5L11.2 13.2L15.2 9.2" stroke="#33f2a5" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                    </div>
                    <div class="screen-title__text">
                        <div class="screen-title__main">安防控制中心</div>
                        <div class="screen-title__sub">Security Vision Command Screen</div>
                    </div>
                </div>
                <div class="header-time">{{ clockText }}</div>
            </header>

            <main class="grid-shell">
                <section class="column">
                    <article class="panel">
                        <div class="panel-head">
                            <div>
                                <h2 class="panel-title">Overall Situation</h2>
                                <p class="panel-subtitle">总体态势</p>
                            </div>
                        </div>
                        <div class="stats-grid">
                            <div class="stat-card">
                                <div class="stat-card__label">Today Events</div>
                                <div class="stat-card__value">{{ dashboard.overview.today_event_count }}</div>
                            </div>
                            <div class="stat-card stat-card--danger">
                                <div class="stat-card__label">High Risk</div>
                                <div class="stat-card__value">{{ dashboard.overview.high_risk_count }}</div>
                            </div>
                            <div class="stat-card stat-card--warn">
                                <div class="stat-card__label">Med Risk</div>
                                <div class="stat-card__value">{{ dashboard.overview.medium_risk_count }}</div>
                            </div>
                            <div class="stat-card stat-card--cyan">
                                <div class="stat-card__label">Alerts Sent</div>
                                <div class="stat-card__value">{{ dashboard.overview.alerts_sent_count }}</div>
                            </div>
                        </div>
                        <div class="mini-grid">
                            <div class="mini-status">
                                <div class="mini-status__label">Cam Status</div>
                                <div class="mini-status__value">{{ dashboard.overview.online_cameras }}/{{ dashboard.overview.total_cameras }}</div>
                                <div class="mini-status__sub">在线摄像头</div>
                            </div>
                            <div class="mini-status">
                                <div class="mini-status__label">Last Task</div>
                                <div class="mini-status__value" :class="{ 'text-danger': dashboard.overview.task_status === 'failed' }">{{ dashboard.overview.task_label }}</div>
                                <div class="mini-status__sub">{{ dashboard.overview.last_task_id || '暂无任务' }}</div>
                            </div>
                        </div>
                    </article>

                    <article class="panel">
                        <div class="panel-head">
                            <div>
                                <h2 class="panel-title">Trend Analysis</h2>
                                <p class="panel-subtitle">趋势分析</p>
                            </div>
                        </div>

                        <div class="chart-block">
                            <h3 class="chart-title">24H Event Trend (24小时趋势)</h3>
                            <div class="line-chart">
                                <svg viewBox="0 0 480 140" width="100%" height="100%" preserveAspectRatio="none">
                                    <defs>
                                        <linearGradient id="trendArea" x1="0" x2="0" y1="0" y2="1">
                                            <stop offset="0%" stop-color="rgba(35,225,255,0.45)" />
                                            <stop offset="100%" stop-color="rgba(35,225,255,0.02)" />
                                        </linearGradient>
                                    </defs>
                                    <line
                                        v-for="grid in hourlyTrendSvg.gridLines"
                                        :key="grid.y"
                                        x1="14"
                                        x2="466"
                                        :y1="grid.y"
                                        :y2="grid.y"
                                        stroke="rgba(125,149,184,0.18)"
                                        stroke-dasharray="4 6"
                                    />
                                    <path :d="hourlyTrendSvg.areaPath" fill="url(#trendArea)"></path>
                                    <path :d="hourlyTrendSvg.linePath" stroke="#23e1ff" stroke-width="3" fill="none" stroke-linecap="round"></path>
                                </svg>
                            </div>
                        </div>

                        <div class="chart-block">
                            <h3 class="chart-title">7-Day Risk Distribution (7天事件分布)</h3>
                            <div class="weekly-bars">
                                <div v-for="item in weeklyTrend" :key="item.date" class="weekly-bar">
                                    <div class="weekly-bar__value">{{ item.total }}</div>
                                    <div class="weekly-bar__track">
                                        <div
                                            class="weekly-bar__fill"
                                            :style="{ height: Math.max(6, item.total / weeklyMax * 100) + '%' }"
                                        ></div>
                                    </div>
                                    <div class="weekly-bar__label">{{ item.label }}</div>
                                </div>
                            </div>
                        </div>

                        <div class="chart-block">
                            <h3 class="chart-title">Risk Time Heatmap (时段热力图)</h3>
                            <div class="heatmap-grid">
                                <div v-for="item in dashboard.trends.heatmap" :key="item.key" class="heat-cell">
                                    <div class="heat-cell__label">{{ item.label }}</div>
                                    <div class="heat-cell__value">{{ item.value }}</div>
                                    <div class="heat-cell__bar">
                                        <div
                                            class="heat-cell__fill"
                                            :style="{ width: Math.max(8, item.intensity * 100) + '%', background: item.color }"
                                        ></div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </article>
                </section>

                <section class="column center-stage">
                    <div class="camera-stage">
                        <article class="camera-frame camera-frame--equal">
                            <div class="camera-frame__body">
                                <img
                                    v-if="primaryCamera && primaryCamera.available && !cameraErrors[primaryCamera.camera_id]"
                                    class="camera-frame__img"
                                    :src="primaryCamera.video_feed_url"
                                    :alt="primaryCamera.name"
                                    @error="markCameraError(primaryCamera.camera_id)"
                                    @load="clearCameraError(primaryCamera.camera_id)"
                                >
                                <div v-else class="camera-frame__placeholder">
                                    <div>主画面暂不可用</div>
                                </div>
                            </div>
                            <div class="camera-frame__top">
                                <div class="camera-top-badges">
                                    <span class="badge badge--danger">REC</span>
                                    <span class="badge badge--cyan">{{ primaryCamera?.name || 'CAM_01' }}</span>
                                </div>
                                <span class="badge badge--status">{{ primaryCamera?.available ? '在线' : '离线' }}</span>
                            </div>
                            <div class="camera-frame__bottom">
                                <div class="feed-meta">
                                    <span>MODE: {{ dashboard.capture_mode === 'remote_manifest' ? 'REMOTE' : 'LOCAL' }}</span>
                                    <span>TASK: {{ dashboard.task.status || 'idle' }}</span>
                                </div>
                            </div>
                        </article>

                        <article class="camera-frame camera-frame--equal">
                            <div class="camera-frame__body">
                                <img
                                    v-if="secondaryCamera && secondaryCamera.available && !cameraErrors[secondaryCamera.camera_id]"
                                    class="camera-frame__img"
                                    :src="secondaryCamera.video_feed_url"
                                    :alt="secondaryCamera.name"
                                    @error="markCameraError(secondaryCamera.camera_id)"
                                    @load="clearCameraError(secondaryCamera.camera_id)"
                                >
                                <div v-else class="camera-frame__placeholder">
                                    <div>次画面暂不可用</div>
                                </div>
                            </div>
                            <div class="camera-frame__top">
                                <div class="camera-top-badges">
                                    <span class="badge">LIVE</span>
                                    <span class="badge badge--cyan">{{ secondaryCamera?.name || 'CAM_02' }}</span>
                                </div>
                                <span class="badge badge--status">{{ secondaryCamera?.available ? '在线' : '离线' }}</span>
                            </div>
                            <div class="camera-frame__bottom">
                                <div class="feed-meta">
                                    <span>CAMERA: {{ secondaryCamera?.camera_id || 'cam02' }}</span>
                                    <span>PREVIEW</span>
                                </div>
                            </div>
                        </article>
                    </div>
                </section>

                <section class="column">
                    <article class="panel assistant-card">
                        <div class="assistant-header">
                            <div class="assistant-avatar">
                                <img :src="FALLBACK_LOGO" alt="小安 logo">
                            </div>
                            <div>
                                <h2 class="assistant-title">智能助理 · 小安</h2>
                                <div class="assistant-subtitle">{{ assistant.modeLabel }}</div>
                            </div>
                        </div>

                        <div class="assistant-status-row">
                            <div class="assistant-status" :class="'assistant-status--' + assistant.mode">
                                <span class="assistant-status__dot"></span>
                                <span>{{ assistant.modeLabel }}</span>
                            </div>
                            <div class="assistant-wave" aria-hidden="true">
                                <span></span><span></span><span></span><span></span>
                            </div>
                        </div>

                        <div class="assistant-greeting">{{ assistant.greeting }}</div>

                        <div class="assistant-input">
                            <input
                                v-model="assistant.input"
                                class="assistant-input__field"
                                :placeholder="assistant.placeholder"
                                @keyup.enter="submitInput"
                            >
                            <button
                                class="assistant-btn assistant-btn--mic"
                                :class="{ 'is-recording': assistant.recording }"
                                @click="toggleRecording"
                                aria-label="语音提问"
                            >
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                                    <path d="M12 15.5A3.5 3.5 0 0 0 15.5 12V7A3.5 3.5 0 1 0 8.5 7V12A3.5 3.5 0 0 0 12 15.5Z" stroke="currentColor" stroke-width="1.8"/>
                                    <path d="M5 11.5A7 7 0 0 0 19 11.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
                                    <path d="M12 18.5V21" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
                                </svg>
                            </button>
                            <button class="assistant-btn" @click="submitInput" aria-label="发送问题">
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                                    <path d="M3 20L21 12L3 4V10L15 12L3 14V20Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
                                </svg>
                            </button>
                        </div>
                        <div class="assistant-hint">{{ assistant.lastHint }}</div>
                    </article>

                    <article v-if="assistant.transcriptVisible" class="panel assistant-transcript">
                        <div class="assistant-transcript__head">
                            <h3 class="assistant-transcript__title">小安对话输出</h3>
                            <button class="assistant-close" @click="closeTranscript" aria-label="关闭文本框">×</button>
                        </div>
                        <div class="assistant-question">{{ assistant.question || '等待新的提问...' }}</div>
                        <div class="assistant-answer">
                            {{ assistant.answer || '...' }}
                            <span v-if="assistant.busy" class="assistant-answer__cursor"></span>
                        </div>
                        <div v-if="assistant.references.length" class="assistant-reference-grid">
                            <div v-for="item in assistant.references.slice(0, 2)" :key="item.image_url + item.timestamp" class="reference-card">
                                <img :src="item.image_url" alt="关联关键帧">
                                <div class="reference-card__meta">
                                    <span>{{ item.camera_name }}</span>
                                    <span>{{ formatReferenceTime(item.event_time) }}</span>
                                </div>
                            </div>
                        </div>
                    </article>
                    <article v-else class="panel panel--compact">
                        <div class="assistant-transcript__head" style="margin-bottom:0;">
                            <h3 class="assistant-transcript__title">小安文本输出已折叠</h3>
                            <button class="assistant-close" @click="openTranscript" aria-label="展开文本框">+</button>
                        </div>
                    </article>

                    <article class="panel">
                        <div class="panel-head">
                            <div>
                                <h2 class="panel-title">Structure</h2>
                                <p class="panel-subtitle">风险结构分析</p>
                            </div>
                        </div>

                        <div class="donut-row">
                            <div class="donut-shell">
                                <div class="donut-ring" :style="donutStyle"></div>
                                <div class="donut-center">
                                    <div>
                                        <div class="donut-center__label">TOTAL</div>
                                        <div class="donut-center__value">{{ structure.total_events }}</div>
                                    </div>
                                </div>
                            </div>
                            <div class="legend-list">
                                <div v-for="item in structure.risk_distribution" :key="item.key" class="legend-item">
                                    <span class="legend-dot" :style="{ background: item.color }"></span>
                                    <span>{{ item.label }}</span>
                                    <strong>{{ item.ratio }}%</strong>
                                </div>
                            </div>
                        </div>

                        <div class="chart-block">
                            <h3 class="chart-title">Exception Types (异常类型)</h3>
                            <div class="anomaly-list">
                                <div v-for="item in structure.anomaly_distribution" :key="item.key" class="anomaly-item">
                                    <span>{{ item.label }}</span>
                                    <div class="progress-track">
                                        <div class="progress-fill" :style="{ width: Math.max(8, item.ratio) + '%', background: item.color }"></div>
                                    </div>
                                    <strong>{{ item.ratio }}%</strong>
                                </div>
                            </div>
                        </div>
                    </article>

                    <article class="panel">
                        <div class="panel-head">
                            <div>
                                <h2 class="panel-title">Intel Logs</h2>
                                <p class="panel-subtitle">实时日志与日报摘要</p>
                            </div>
                        </div>

                        <div class="log-list">
                            <div
                                v-for="log in latestLogs"
                                :key="log.time + log.category + log.message"
                                class="log-item"
                                :class="{ 'log-item--high': isHighLog(log) }"
                            >
                                <div class="log-item__title">[{{ log.category }}] {{ log.time }}</div>
                                <div class="log-item__desc">{{ log.message }}</div>
                            </div>
                        </div>

                        <div class="summary-card">
                            <h3 class="summary-card__title">{{ summaryCard.title }}</h3>
                            <div class="summary-card__text">{{ summaryCard.overall_summary }}</div>
                        </div>
                    </article>
                </section>
            </main>

            <audio ref="audioPlayerRef" preload="auto"></audio>
        </div>
    `,
}).mount("#dashboard-app");
