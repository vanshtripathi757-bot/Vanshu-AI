# Vanshu AI

A mobile-friendly personal AI assistant with chat mode, agent mode, saved conversations, and browser-based speech input/output.

## Vercel environment variables

- `INTELLIGENCE_API_KEY`: Chat mode key. This route expects an OpenRouter-compatible API key. If omitted, it falls back to `OPENROUTER_API_KEY`.
- `AGENTIC_API_KEY`: Agent mode key. This route expects an OpenRouter-compatible API key. If omitted, it falls back to `OPENROUTER_API_KEY`.
- `INTELLIGENCE_MODEL`: Optional model ID for chat mode.
- `AGENTIC_MODEL`: Optional model ID for agent mode. Existing `OPENROUTER_AGENT_MODEL` and `OPENROUTER_MODEL` remain fallbacks.
- `OPENROUTER_API_KEY`: Shared fallback key for either route.
- `OPENRPUTER_SPEECH_AI`: OpenRouter API key used server-side by `/api/speech` for text-to-speech. Keep it in Vercel environment variables and never expose it in frontend code. Optional: `OPENROUTER_TTS_MODEL` and `OPENROUTER_TTS_VOICE` override the default low-latency model (`microsoft/mai-voice-2.1-flash`) and voice (`en-US-Harper:MAI-Voice-2.1-Flash`). The model and voice must be a supported pair.
- Legacy `GEMINI_API_KEY` is not used by the current chat/agent routes.

Select Production in Vercel for production use; select Preview/Development too if you test those environments. Redeploy after changing environment variables. Chat and agent keys must be valid for the OpenRouter-compatible endpoint. Separate API keys do not automatically add provider credits or quota.

## Features

- Responsive, mobile-friendly chat UI
- Separate Chat and Agent modes
- Multi-turn context and saved chat history
- Browser speech recognition for voice input where supported
- OpenRouter text-to-speech for assistant replies, with the API key kept server-side
- Request validation and provider error handling

## Security

Never commit API keys to GitHub or put them in client-side JavaScript. Keep all provider credentials in Vercel environment variables. Add rate limiting before making the app public.
