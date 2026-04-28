// Page-world hook. Installed synchronously by the content script at
// document_start. Wraps fetch() and XMLHttpRequest, tees streaming responses,
// and posts events to the content script via window.postMessage.

(function () {
  if (window.__AI_CHAT_LOGGER_INJECT__) return;
  window.__AI_CHAT_LOGGER_INJECT__ = true;

  const ENDPOINT_PATTERNS = [
    // claude.ai
    /\/api\/organizations\/[^/]+\/chat_conversations\/[^/]+\/(completion|retry_completion)/,
    // chatgpt.com / chat.openai.com
    /\/backend-api\/(f\/)?conversation/,
    // chat.deepseek.com
    /\/api\/v0\/chat\/completion/,
    /\/chat\/completion/,
    // gemini.google.com (batchexecute is the streaming endpoint)
    /StreamGenerate/,
    /\/_\/BardChatUi\/data\/assistant\.lamda\.BardFrontendService\/StreamGenerate/,
    /\/batchexecute/,
  ];

  const post = (kind, data) => {
    try {
      window.postMessage({ __AI_CHAT_LOGGER: true, kind, data }, location.origin);
    } catch {}
  };

  const matches = (url) => {
    if (!url) return false;
    return ENDPOINT_PATTERNS.some((re) => re.test(url));
  };

  post('hook-installed', { href: location.href });

  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = async function patchedFetch(input, init) {
      const url =
        typeof input === 'string'
          ? input
          : input && typeof input.url === 'string'
          ? input.url
          : '';
      const isChat = matches(url);

      if (isChat) {
        let body = '';
        try {
          if (init && typeof init.body === 'string') body = init.body;
          else if (init && init.body && typeof init.body.text === 'function') {
            // best effort; consuming body on Request would break the call
          }
        } catch {}
        post('request', { url, method: (init && init.method) || 'POST', body });
      }

      const response = await origFetch.apply(this, arguments);
      if (!isChat || !response || !response.body) return response;

      try {
        const [forCaller, forUs] = response.body.tee();
        const reader = forUs.getReader();
        const decoder = new TextDecoder('utf-8');
        (async () => {
          while (true) {
            try {
              const { value, done } = await reader.read();
              if (done) {
                post('stream-end', { url });
                break;
              }
              const chunk = decoder.decode(value, { stream: true });
              if (chunk) post('stream-chunk', { url, chunk });
            } catch (err) {
              post('stream-error', { url, error: String(err) });
              break;
            }
          }
        })();

        return new Response(forCaller, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch {
        return response;
      }
    };
  }

  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;

    XHR.prototype.open = function (method, url) {
      this.__aiLoggerUrl = url;
      this.__aiLoggerMethod = method;
      return origOpen.apply(this, arguments);
    };

    XHR.prototype.send = function (body) {
      const url = this.__aiLoggerUrl || '';
      if (matches(url)) {
        try {
          post('request', {
            url,
            method: this.__aiLoggerMethod || 'POST',
            body: typeof body === 'string' ? body : '',
          });
        } catch {}

        let lastLen = 0;
        this.addEventListener('progress', () => {
          try {
            const text = this.responseText || '';
            if (text.length > lastLen) {
              const chunk = text.slice(lastLen);
              lastLen = text.length;
              post('stream-chunk', { url, chunk });
            }
          } catch {}
        });
        this.addEventListener('loadend', () => {
          try {
            const text = this.responseText || '';
            if (text.length > lastLen) {
              post('stream-chunk', { url, chunk: text.slice(lastLen) });
            }
          } catch {}
          post('stream-end', { url });
        });
      }
      return origSend.apply(this, arguments);
    };
  }
})();
