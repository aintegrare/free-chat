import { Index, Match, Show, Switch, batch, createEffect, createSignal, onMount } from 'solid-js'
import { Toaster, toast } from 'solid-toast'
import { useThrottleFn } from 'solidjs-use'
import { fetchModeration, fetchTranslation, iterateSuggestion, iterateTitle } from '@/utils/misc'
import { audioChunks, getAudioBlob, startRecording, stopRecording } from '@/utils/record'
import { countTokens, tokenCountCache } from '@/utils/tiktoken'
import { MessagesEvent } from '@/utils/events'
import { promplateBaseUrl as baseUrl } from '@/utils/constants'
import { trackEvent } from '@/utils/track'
import IconClear from './icons/Clear'
import MessageItem from './MessageItem'
import SystemRoleSettings from './SystemRoleSettings'
import ErrorMessageItem from './ErrorMessageItem'
import TokenCounter, { encoder } from './TokenCounter'
import type { LocalStorageSetEvent } from '@/utils/events'
import type { ChatMessage, ErrorMessage } from '@/types'
import type { Setter } from 'solid-js'

export const minMessages = Number(import.meta.env.PUBLIC_MIN_MESSAGES ?? 3)
export const maxTokens = Number(import.meta.env.PUBLIC_MAX_TOKENS ?? 3000)

export default () => {
  let rootRef: HTMLDivElement
  let inputRef: HTMLTextAreaElement
  let bgd: HTMLDivElement
  let footer: HTMLElement

  const [currentSystemRoleSettings, _setCurrentSystemRoleSettings] = createSignal('')
  const [systemRoleEditing, setSystemRoleEditing] = createSignal(false)
  const [messageList, setMessageList] = createSignal<ChatMessage[]>([])
  const [currentError, setCurrentError] = createSignal<ErrorMessage | null>(null)
  const [currentAssistantMessage, setCurrentAssistantMessage] = createSignal('')
  const [streaming, setStreaming] = createSignal(false)
  const [controller, setController] = createSignal<AbortController | null>(null)
  const [inputValue, setInputValue] = createSignal('')
  const [isStick, _setStick] = createSignal(false)
  const [mounted, setMounted] = createSignal(false)
  const [recording, setRecording] = createSignal<'recording' | 'processing' | false>(false)
  const [suggestions, setSuggestions] = createSignal<string[]>([])
  const [suggestionFeatureOn, setSuggestionFeature] = createSignal(true)

  const moderationInterval = Number(import.meta.env.PUBLIC_MODERATION_INTERVAL ?? '2000')

  const isHigher = () => {
    const distanceToBottom = footer.offsetTop - window.innerHeight
    const currentScrollHeight = window.scrollY
    return distanceToBottom > currentScrollHeight
  }

  const setCurrentSystemRoleSettings = (systemRole: string) => {
    _setCurrentSystemRoleSettings(systemRole) ? localStorage.setItem('systemRoleSettings', systemRole) : localStorage.removeItem('systemRoleSettings')
    return systemRole
  }

  const syncMessageList = () => {
    localStorage.setItem('messageList', JSON.stringify(messageList()))
  }

  const setStick = (stick: boolean) => {
    _setStick(stick) ? localStorage.setItem('stickToBottom', 'stick') : localStorage.removeItem('stickToBottom')
    return stick
  }

  createEffect(() => {
    isStick() && (streaming() ? instantToBottom() : smoothToBottom())
  })

  const resetTextInputHeight = () => {
    if (inputRef) {
      inputRef.style.height = 'auto'
      inputRef.style.height = `${inputRef.scrollHeight}px`
    }
  }

  const updateSuggestions = async() => {
    if (messageList().length === 0 || !suggestionFeatureOn()) return
    setSuggestions([])
    for await (const suggestions of iterateSuggestion([...messageList()]))
      setSuggestions(suggestions)
  }

  createEffect(() => {
    if (messageList().at(-1)?.role === 'assistant') updateSuggestions()
    else if (messageList().length === 0) setSuggestions([])
  })

  onMount(() => {
    setMounted(true)

    setSuggestionFeature(JSON.parse(localStorage.getItem('suggestion') ?? 'true'))

    document.addEventListener('localStorageSet', (({ detail: { key, value } }: LocalStorageSetEvent) => {
      if (key === 'suggestion') setSuggestionFeature(JSON.parse(value) ?? 'true')
    }) as EventListener)

    try {
      if (JSON.parse(localStorage.getItem('messageList') ?? '[]').length) {
        setMessageList(JSON.parse(localStorage.getItem('messageList') ?? '[]'))
        if (localStorage.getItem('title')) setPageTitle(localStorage.getItem('title')!)
        else updatePageTitle(messageList()[0].content)
      }

      if (localStorage.getItem('stickToBottom') === 'stick')
        setStick(true)

      if (localStorage.getItem('systemRoleSettings'))
        setCurrentSystemRoleSettings(localStorage.getItem('systemRoleSettings') ?? '')

      createEffect(() => {
        inputRef && (inputRef.value = inputValue())
      })

      createEffect(() => {
        inputValue()
        resetTextInputHeight()
      })
    } catch (err) {
      console.error(err)
    }

    footer = document.querySelector('footer')!

    let lastPosition = window.scrollY

    window.addEventListener('scroll', () => {
      const nowPosition = window.scrollY
      if (nowPosition < lastPosition && isHigher()) setStick(false)
      lastPosition = nowPosition
    })

    window.addEventListener('resize', () => {
      resetTextInputHeight()
      requestAnimationFrame(() => {
        if (isHigher() && isStick()) instantToBottom()
        lastPosition = window.scrollY
      })
    })

    window.addEventListener('keydown', (event) => {
      if ((event.target as HTMLElement).nodeName !== 'TEXTAREA') {
        if (event.code === 'Slash') {
          event.preventDefault()
          inputRef.focus()
        } else if (event.code === 'KeyB') {
          trackEvent('stick-to-bottom', { stick: isStick() ? 'switch off' : 'switch on', trigger: 'key' })
          setStick(!isStick())
        }
      }
      if (event.altKey && event.code === 'KeyC') clear()
    }, false)

    new MutationObserver(() => isStick() && instantToBottom()).observe(rootRef!, { childList: true, subtree: true })

    window.addEventListener('scroll', () => {
      bgd.style.setProperty('--scroll', `-${document.documentElement.scrollTop / 10}pt`)
    })
  })

  const setPageTitle = (title = 'Endless Chat') => {
    document.title = title
    const titleRef: HTMLSpanElement | null = document.querySelector('span.gpt-title')
    titleRef && (titleRef.innerHTML = title)
    const subTitleRef: HTMLSpanElement | null = document.querySelector('span.gpt-subtitle')
    subTitleRef?.classList.toggle('hidden', title !== 'Endless Chat')
    title !== 'Endless Chat' ? localStorage.setItem('title', title) : localStorage.removeItem('title')
  }

  const moderationCache: Record<string, string[]> = {}

  let hasBeenInformed = 0

  const moderate = async(input: string) => {
    if (!input.length) return
    if (!moderationInterval) return
    const flags = moderationCache[input] ?? (await fetchModeration(input)).flags
    moderationCache[input] = flags
    if (!flags.length) return
    toast.error(`${flags.join(', ')} detected!`, { position: 'top-center' })
    if (hasBeenInformed++ <= 2) {
      setTimeout(() => toast.error('现在暂时没有影响，未来可能会强制合规', { position: 'top-center', iconTheme: { primary: 'SandyBrown' } }), 500)
      setTimeout(() => toast.error('如有异议可通过页面下方问题反馈联系我', { position: 'top-center', iconTheme: { primary: 'SandyBrown' } }), 700)
    }
    toast.error(await fetchTranslation(`detect ${flags.join(', ')} which violates our policy`), { position: 'top-center' })
  }

  const throttledModerate = useThrottleFn((input: string) => { moderate(input) }, moderationInterval)

  createEffect(() => throttledModerate(currentSystemRoleSettings()))
  createEffect(() => throttledModerate(inputValue()))
  createEffect(() => throttledModerate(currentAssistantMessage()))

  const updatePageTitle = async(input: string) => {
    for await (const title of iterateTitle(input))
      setPageTitle(title)
  }

  const errorHelper = (e: any) => {
    return toast.error(String(e), { position: 'top-center' })
  }

  const handleSubmit = async() => {
    trackEvent(inputValue() ? 'send' : `${recording() ? 'end' : 'start'}Record`, recording() ? undefined : { length: messageList().length })

    if (recording()) {
      stopRecording()
      setRecording('processing')
      const blob = await getAudioBlob()
      audioChunks.length = 0

      const res = await fetch('/api/transcript', { body: blob, method: 'POST', headers: { 'Content-Type': 'audio/webm' } })
      const text = await res.text()

      setRecording(false)

      if (!res.ok) {
        errorHelper(`Error processing audio: ${res.statusText}`)
      } else if (text) {
        setInputValue(text)
        handleSubmit()
      }

      return
    }

    setSuggestions([])

    const input = inputValue()

    if (!input) return startRecording().then(() => setRecording('recording')).catch(errorHelper)

    if (messageList().length === 0) updatePageTitle(input)

    moderate(input)

    batch(() => {
      setMessageList([...messageList(), { role: 'user', content: input }])
      setInputValue('')
    })

    smoothToBottom()
    requestWithLatestMessage()
    syncMessageList()
  }

  const toBottom = (behavior: 'smooth' | 'instant') => {
    const distanceToBottom = footer.offsetTop - window.innerHeight
    const currentScrollHeight = window.scrollY
    if (distanceToBottom > currentScrollHeight)
      window.scrollTo({ top: distanceToBottom, behavior })
  }

  const smoothToBottom = () => toBottom('smooth')
  const instantToBottom = () => toBottom('instant')

  const requestWithLatestMessage = async() => {
    setStreaming(true)
    setCurrentAssistantMessage('')
    setCurrentError(null)
    try {
      const controller = new AbortController()
      setController(controller)
      const requestMessageList = [...messageList()]

      let limit = maxTokens

      const systemMsg = currentSystemRoleSettings()
        ? {
            role: 'system',
            content: currentSystemRoleSettings(),
          } as ChatMessage
        : null

      systemMsg && (limit -= countTokens(encoder()!, [systemMsg])!.total)

      while (requestMessageList.length > minMessages && countTokens(encoder()!, requestMessageList)!.total > limit)
        requestMessageList.shift()

      systemMsg && requestMessageList.unshift(systemMsg)

      const headers: Record<string, any> = { 'content-type': 'application/json' }
      if (localStorage.getItem('apiKey')) headers.authorization = `Bearer ${localStorage.getItem('apiKey')}`

      const t = localStorage.getItem('temperature') ?? 'undefined'
      const payload: Record<string, any> = { messages: requestMessageList, temperature: t === 'undefined' ? undefined : JSON.parse(t) }
      if (localStorage.getItem('model')) payload.model = localStorage.getItem('model')

      const res = await fetch(`${baseUrl}/single/chat_messages`, {
        method: 'PUT',
        body: JSON.stringify(payload),
        signal: controller.signal,
        headers,
      })
      if (!res.ok) {
        const message = await res.text()
        console.error(message)
        setCurrentError({ code: `${res.status} ${res.statusText}`, message })
        throw new Error('Request failed')
      }
      const data = res.body
      if (!data)
        throw new Error('No data')

      const reader = data.getReader()
      const decoder = new TextDecoder('utf-8')
      let done = false

      let realValue = ''
      let displayValue = ''
      let lastTime = Date.now()
      const intervals = [0]

      const N = 5
      const MAX = 500
      const FACTOR = 50

      const getProperInterval = () => {
        const slidingWindowMean = intervals.slice(-N).reduce((a, b) => a + b, 0) / Math.min(intervals.length, N)
        return Math.min(slidingWindowMean, MAX / (realValue.length - displayValue.length))
      }

      const update = async() => {
        if (!streaming()) return fastForward()

        const distance = realValue.length - displayValue.length
        if (!done) {
          const num = Math.round(distance / FACTOR) || 1
          displayValue = realValue.slice(0, displayValue.length + num)
          setCurrentAssistantMessage(displayValue)
          //
          realValue !== displayValue ? setTimeout(update, Math.round(getProperInterval())) : requestAnimationFrame(update)
        }
      }

      const fastForward = () => {
        const distance = realValue.length - displayValue.length
        if (distance) {
          const num = Math.round(distance / FACTOR) || 1
          displayValue = realValue.slice(0, displayValue.length + num)
          setCurrentAssistantMessage(displayValue)
          //
          if (realValue === displayValue) return archiveCurrentMessage()

          const interval = Math.floor(10 / (realValue.length - displayValue.length))

          interval ? setTimeout(fastForward, interval) : requestAnimationFrame(fastForward)
        } else {
          return archiveCurrentMessage()
        }
      }

      update()

      while (!done) {
        const { value, done: readerDone } = await reader.read()
        if (value) {
          const char = decoder.decode(value)
          if (char === '\n' && currentAssistantMessage().endsWith('\n'))
            continue

          if (char) {
            realValue += char
            intervals.push(Date.now() - lastTime)
            lastTime = Date.now()
          }
        }
        done = readerDone
        done && fastForward()
      }
    } catch (e) {
      console.error(e)
      setStreaming(false)
      setController(null)
    }
  }

  const archiveCurrentMessage = () => {
    if (currentAssistantMessage()) {
      batch(() => {
        setMessageList([...messageList(), { role: 'assistant', content: currentAssistantMessage() }])
        setCurrentAssistantMessage('')
      })
      setStreaming(false)
      setController(null)
      syncMessageList()
    }
  }

  const clear = () => {
    document.dispatchEvent(new MessagesEvent('clearMessages', messageList().length + Number(Boolean(currentSystemRoleSettings()))))
    inputRef.value = ''
    inputRef.style.height = 'auto'
    tokenCountCache.clear()
    trackEvent('clear', { length: messageList().length })
    batch(() => {
      setInputValue('')
      setMessageList([])
      // setCurrentAssistantMessage('')
      // setCurrentSystemRoleSettings('')
    })

    setMessageList([])
    syncMessageList()
    setCurrentError(null)
    setPageTitle()
  }

  const stopStreamFetch = () => {
    if (controller()) {
      controller()!.abort()
      setStreaming(false)
    }
  }

  const retryLastFetch = () => {
    if (messageList().length > 0) {
      trackEvent('retry', { length: messageList().length, lastMessage: messageList().at(-1)!.role })
      const lastMessage = messageList()[messageList().length - 1]
      if (lastMessage.role === 'assistant')
        setMessageList(messageList().slice(0, -1))

      requestWithLatestMessage()
      syncMessageList()
    }
  }

  const handleKeydown = (e: KeyboardEvent) => {
    if (e.isComposing || e.shiftKey)
      return

    if (e.key === 'Enter') {
      e.preventDefault()
      handleSubmit()
    }
  }

  return (
    <div ref={rootRef!} class="relative h-full flex flex-grow flex-col justify-between">
      <div
        ref={bgd!}
        class="<md:hiddern fixed left-0 top-0 z--1 h-1000vh w-full translate-y-$scroll bg-top-center op-100 transition-opacity duration-1000 bg-hero-jigsaw-gray-500/10 <md:bg-none"
        class:op-0={!mounted()}
        class:transition-transform={isStick() && streaming()}
        class:duration-400={isStick() && streaming()}
      />
      <SystemRoleSettings
        canEdit={() => messageList().length === 0}
        systemRoleEditing={systemRoleEditing}
        setSystemRoleEditing={setSystemRoleEditing}
        currentSystemRoleSettings={currentSystemRoleSettings}
        setCurrentSystemRoleSettings={setCurrentSystemRoleSettings as Setter<string>}
      />
      <div class="w-full flex flex-grow items-center justify-center">
        {
        !streaming() && messageList().length === 0 && !systemRoleEditing() && (
          <div id="tips" class="relative flex flex-col select-none gap-5 rounded-md bg-$c-fg-2 p-7 text-sm op-50 transition-opacity">
            <span class="absolute right-0 top-0 h-fit w-fit rounded-bl-md rounded-rt-md bg-$c-fg-5 px-2 py-1 text-$c-fg-50 font-bold">TIPS</span>
            <p><span class="rounded-md bg-$c-fg-5 px-1.75 py-1 font-mono ring-1.2 ring-$c-fg-20">B</span> &nbsp;开启/关闭跟随最新消息功能 </p>
            <p><span class="rounded-md bg-$c-fg-5 px-1.75 py-1 font-mono ring-1.2 ring-$c-fg-20">/</span> &nbsp;聚焦到输入框 </p>
            <p><span class="rounded-md bg-$c-fg-5 px-1.75 py-1 font-mono ring-1.2 ring-$c-fg-20">Alt/Option</span> + <span class="rounded-md bg-$c-fg-5 px-1.75 py-1 font-mono ring-1.2 ring-$c-fg-20">C</span> &nbsp;清空上下文 </p>
            <p><span class="rounded-md bg-$c-fg-5 px-1.75 py-1 font-mono ring-1.2 ring-$c-fg-20">鼠标中键点击左上标题</span> &nbsp;新窗口打开新会话 </p>
            <p><span class="rounded-md bg-$c-fg-5 px-1.75 py-1 font-mono ring-1.2 ring-$c-fg-20">PageUp</span> / <span class="rounded-md bg-$c-fg-5 px-1.75 py-1 font-mono ring-1.2 ring-$c-fg-20">PageDn</span> &nbsp;回到顶部 / 底部 </p>
          </div>
        )
        }
      </div>
      <Index each={messageList()}>
        {(message, index) => (
          <MessageItem
            role={message().role}
            message={message().content}
            showRetry={() => (!streaming() && !currentError() && index === messageList().length - 1)}
            onRetry={retryLastFetch}
          />
        )}
      </Index>
      {currentAssistantMessage() && (
        <MessageItem
          role="assistant"
          message={currentAssistantMessage}
        />
      )}

      { currentError() && <ErrorMessageItem data={currentError()!} onRetry={retryLastFetch} /> }

      <TokenCounter
        currentSystemRoleSettings={currentSystemRoleSettings}
        messageList={messageList}
        textAreaValue={inputValue}
        currentAssistantMessage={currentAssistantMessage}
        hide={suggestionFeatureOn() && !streaming() && !!suggestions().length}
      />

      <Show when={suggestionFeatureOn() && !streaming() && suggestions().length}>
        <div class="flex flex-row flex-wrap translate-y-1.5 gap-2 [&>button]:(rounded bg-$c-fg-5 px-1 py-1 text-start text-xs text-$c-fg-90 outline-none ring-$c-fg-50 transition-background-color)">
          <Index each={suggestions()}>
            {(item, index) => <button type="button" onClick={() => [setInputValue(item()), inputRef.focus(), trackEvent('accept-suggestion', { index })]} class="animate-(fade-in duration-200) hover:bg-$c-fg-10 focus-visible:ring-1.3">{item()}</button>}
          </Index>
        </div>
      </Show>

      <Switch>
        <Match when={!mounted()}>
          <div class="animate-fade-in animate-duration-300 gen-cb-wrapper">
            <div class="flex flex-row items-center gap-2">
              <span>加载中</span>
              <span i-svg-spinners-6-dots-scale-middle />
            </div>
          </div>
        </Match>
        <Match when={mounted() && streaming()}>
          <div class="gen-cb-wrapper">
            <div class="flex flex-row animate-fade-in animate-duration-300 items-center gap-3">
              <span i-svg-spinners-ring-resize />
              <span>等待响应中</span>
              <div class="gen-cb-stop" onClick={stopStreamFetch}>Stop</div>
            </div>
          </div>
        </Match>
        <Match when={mounted() && !streaming()}>
          <div class="gen-text-wrapper" class:op-50={systemRoleEditing()}>
            <textarea
              ref={inputRef!}
              disabled={systemRoleEditing() || recording() as boolean}
              onKeyDown={handleKeydown}
              placeholder={recording() ? (recording() === 'processing' ? '正在转录语音' : '正在录音') : '与 LLM 对话'}
              autocomplete="off"
              onInput={() => setInputValue(inputRef.value)}
              rows="1"
              class="gen-textarea"
              data-lenis-prevent
            />
            <button
              title={inputValue() ? 'Send' : 'Record'}
              type="button"
              class="w-10 gen-slate-btn"
              onClick={handleSubmit}
              disabled={systemRoleEditing() || recording() === 'processing'}
            >
              <Switch>
                <Match when={inputValue()}>
                  <span class="i-iconamoon-send" />
                </Match>
                <Match when={recording() === false}>
                  <span class="i-iconamoon-microphone-fill" />
                </Match>
                <Match when={recording() === 'recording'}>
                  <span class="i-iconamoon-player-stop-fill" />
                </Match>
                <Match when={recording() === 'processing'}>
                  <span class="i-svg-spinners-90-ring-with-bg" />
                </Match>
              </Switch>
            </button>
            <Show when={messageList().length && !inputValue()}>
              <button title="Clear" type="button" onClick={clear} disabled={systemRoleEditing()} gen-slate-btn>
                <IconClear />
              </button>
            </Show>
          </div>

        </Match>
      </Switch>
      <div class="fixed bottom-4.25 left-4.25 z-10 h-fit w-fit rounded-md transition-colors sm:bottom-5 sm:left-5 active:scale-90 hover:bg-$c-fg-5" class:stick-btn-on={isStick()}>
        <button
          class="p-2.5 text-base"
          title="stick to bottom"
          type="button"
          onClick={() => {
            setStick(!isStick())
            trackEvent('stick-to-bottom', { stick: isStick() ? 'switch off' : 'switch on', trigger: 'mouse' })
          }}
        >
          <div i-ph-arrow-line-down-bold />
        </button>
      </div>

      <Toaster />
    </div>
  )
}
