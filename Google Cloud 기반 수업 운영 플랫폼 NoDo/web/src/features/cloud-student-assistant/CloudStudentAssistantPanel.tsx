import { Bot, MessageCircleQuestion, Send, Sparkles } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import type { User } from "firebase/auth";
import {
  askStudentRoomAssistant,
  studentAssistantErrorMessage,
} from "./cloudStudentAssistantApi";
import styles from "./CloudStudentAssistantPanel.module.css";

type AssistantFlowItem = {
  itemId: string;
  itemNumber: string;
  itemTitle: string;
  itemDescription: string;
};

type AssistantMessage = {
  id: string;
  kind: "assistant" | "student";
  content: string;
};

type CloudStudentAssistantPanelProps = {
  user: User | null;
  orgId: string;
  roomCode: string;
  roomStatus: "READY" | "LIVE" | "ENDED";
  currentItemId: string | null;
  flowItems: AssistantFlowItem[];
};

const suggestedPrompts = [
  "지금 배우는 내용을 쉽게 설명해 줘.",
  "핵심 개념을 세 줄로 요약해 줘.",
  "이 개념의 간단한 예시를 들어 줘.",
];

function newMessageId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

export function CloudStudentAssistantPanel({
  user,
  orgId,
  roomCode,
  roomStatus,
  currentItemId,
  flowItems,
}: CloudStudentAssistantPanelProps) {
  const [selectedItemId, setSelectedItemId] = useState(currentItemId ?? "");
  const [content, setContent] = useState("");
  const [messages, setMessages] = useState<AssistantMessage[]>([
    {
      id: "welcome",
      kind: "assistant",
      content: "안녕하세요. 저는 NoDo 학습 도우미예요. 현재 강의 흐름을 바탕으로 어려운 내용을 함께 정리해 볼게요.",
    },
  ]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSelectedItemId((selected) => selected || currentItemId || "");
  }, [currentItemId]);

  async function ask(nextContent: string) {
    const question = nextContent.trim();
    if (!question || sending || roomStatus === "ENDED") return;
    setError(null);
    setSending(true);
    setMessages((current) => [
      ...current,
      { id: newMessageId(), kind: "student", content: question },
    ]);
    setContent("");
    try {
      const result = await askStudentRoomAssistant(
        user,
        orgId,
        roomCode,
        question,
        selectedItemId || null,
      );
      setMessages((current) => [
        ...current,
        { id: newMessageId(), kind: "assistant", content: result.reply },
      ]);
    } catch (requestError) {
      setError(studentAssistantErrorMessage(requestError));
      setContent(question);
    } finally {
      setSending(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void ask(content);
  }

  const activeItem = flowItems.find((item) => item.itemId === selectedItemId) ?? null;

  return (
    <section className={styles.panel} aria-label="AI 학습 도우미">
      <header className={styles.hero}>
        <div className={styles.avatar} aria-hidden="true"><Bot /></div>
        <div>
          <p><Sparkles aria-hidden="true" /> NoDo AI 도우미</p>
          <h2>막히는 부분을 바로 물어보세요</h2>
          <span>{activeItem ? `${activeItem.itemNumber} · ${activeItem.itemTitle}` : "현재 강의 흐름"}을 기준으로 도와드릴게요.</span>
        </div>
      </header>

      <div className={styles.messages} aria-live="polite" aria-label="AI 도우미 대화">
        {messages.map((message) => (
          <article key={message.id} className={message.kind === "assistant" ? styles.assistantMessage : styles.studentMessage}>
            {message.kind === "assistant" ? <Bot aria-hidden="true" /> : <MessageCircleQuestion aria-hidden="true" />}
            <p>{message.content}</p>
          </article>
        ))}
        {sending ? <div className={styles.typing} role="status"><span /><span /><span /> 답변을 정리하고 있어요.</div> : null}
      </div>

      {messages.length === 1 && roomStatus !== "ENDED" ? (
        <div className={styles.suggestions} aria-label="추천 질문">
          {suggestedPrompts.map((prompt) => <button key={prompt} type="button" disabled={sending} onClick={() => void ask(prompt)}>{prompt}</button>)}
        </div>
      ) : null}

      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {roomStatus === "ENDED" ? (
        <p className={styles.ended}>종료된 강의에서는 새 AI 질문을 남길 수 없습니다.</p>
      ) : (
        <form className={styles.composer} onSubmit={submit} aria-label="AI 도우미에게 질문하기">
          <label htmlFor="assistant-context">질문 문맥</label>
          <select id="assistant-context" value={selectedItemId} onChange={(event) => setSelectedItemId(event.target.value)} disabled={sending}>
            <option value="">현재 진행 항목</option>
            {flowItems.map((item) => <option key={item.itemId} value={item.itemId}>{item.itemNumber} · {item.itemTitle}</option>)}
          </select>
          <div className={styles.inputRow}>
            <label className={styles.srOnly} htmlFor="assistant-content">AI 도우미 질문</label>
            <textarea id="assistant-content" value={content} onChange={(event) => { setContent(event.target.value); setError(null); }} maxLength={500} disabled={sending} placeholder="이 부분을 쉽게 설명해 줘" />
            <button type="submit" disabled={!content.trim() || sending} aria-label="AI 도우미에게 질문 전송">
              <Send aria-hidden="true" />
            </button>
          </div>
          <small>AI 답변은 학습 보조용입니다. 공식 안내는 강사 채팅을 확인해 주세요.</small>
        </form>
      )}
    </section>
  );
}
