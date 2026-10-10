const chat = document.getElementById("chat");
const chatForm = document.getElementById("chatForm");
const messageInput = document.getElementById("messageInput");
const sendButton = chatForm.querySelector(".send-btn");
const dateLine = document.getElementById("dateLine");

// 오늘 날짜 표시시
function setDateLine() {
  const today = new Date();
  const weekdays = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"];
  dateLine.textContent = `- ${today.getFullYear()}. ${today.getMonth() + 1}. ${today.getDate()} ${weekdays[today.getDay()]} -`;
}

// 사용자의 정보 갖고오기
function getProfile() {
  return {
    gender: document.getElementById("gender").value,
    age: document.getElementById("age").value,
    height: document.getElementById("height").value,
    weight: document.getElementById("weight").value,
    avoid: document.getElementById("avoid").value,
  };
}

// 채팅창을 아래로 이동
function scrollToBottom() {
  chat.scrollTop = chat.scrollHeight;
}

// 말풍선 추가
function addMessage(type, html) {
  const row = document.createElement("div");
  row.className = `message ${type}`;
  row.innerHTML = `<div class="bubble">${html}</div>`;
  chat.appendChild(row);
  scrollToBottom();
  return row;
}

// 사용자 말풍선 추가
function addUserMessage(text) {
  addMessage("user", escapeHtml(text).replace(/\n/g, "<br>"));
}

// 봇에 말풍선 추가
function addBotMessage(text) {
  addMessage("bot", escapeHtml(text).replace(/\n/g, "<br>"));
}

// HTM 특수문자 처리
function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// 빈 값 일때 처리
function valueOrDash(value, suffix = "") {
  if (value === null || value === undefined || value === "") {
    return "-";
  }
  return `${value}${suffix}`;
}

// 추천 식품 카드 생성성
function foodCard(item) {
  const reasons = (item.reasons || []).map((reason) => `<li>${escapeHtml(reason)}</li>`).join("");
  return `
    <article class="food-item">
      <span class="tag">${escapeHtml(valueOrDash(item.group))}</span>
      <h3>${escapeHtml(item.name)}</h3>
      <div class="serving">점수 <strong>${valueOrDash(item.score)}점</strong> · 기준 ${escapeHtml(valueOrDash(item.serving))}</div>
      <div class="nutrients">
        <span>당류 ${valueOrDash(item.sugar, "g")}</span>
        <span>나트륨 ${valueOrDash(item.sodium, "mg")}</span>
        <span>단백질 ${valueOrDash(item.protein, "g")}</span>
      </div>
      <ul class="reasons">${reasons}</ul>
    </article>
  `;
}

// 추천 받은 결과 출력
function addRecommendation(data) {
  if (data.response_type === "chat") {
    addBotMessage(data.answer || data.ai_explanation || "현재 상태나 원하는 식단을 말해주시면 추천해드릴게요.");
    return;
  }

  const profile = data.profile || {};
  const foods = data.recommendations || [];
  const cards = foods.map(foodCard).join("");
  const html = `
    <section class="result-card">
      <h2>추천 결과</h2>
      <div class="result-meta">
        <div class="metric"><span>BMI</span><strong>${valueOrDash(profile.bmi)}</strong></div>
        <div class="metric"><span>판정</span><strong>${escapeHtml(valueOrDash(profile.bmi_group))}</strong></div>
      </div>
      <div class="food-list">${cards}</div>
      <div class="ai-note">${escapeHtml(data.ai_explanation || "추천 설명이 없습니다.").replace(/\n/g, "<br>")}</div>
    </section>
  `;
  const row = document.createElement("div");
  row.className = "message bot";
  row.innerHTML = html;
  chat.appendChild(row);
  scrollToBottom();
}

// 전송 버튼 상태 변경
function setLoading(isLoading) {
  sendButton.disabled = isLoading;
  sendButton.textContent = isLoading ? "분석중" : "전송";
}

// 질문 입력 후 서버로 전송후 결과 받기
async function sendQuestion(question) {
  const text = question.trim();
  if (!text) {
    addBotMessage("질문을 입력해주세요.");
    return;
  }

  addUserMessage(text);
  messageInput.value = "";
  setLoading(true);
  const typing = addMessage("bot", `<span class="typing">추천 식단을 준비하고 있습니다...</span>`);

  try {
    const response = await fetch("/api/recommend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...getProfile(), question: text }),
    });
    const data = await response.json();
    typing.remove();
    if (!response.ok) {
      throw new Error(data.error || "추천 요청 실패");
    }
    addRecommendation(data);
  } catch (error) {
    typing.remove();
    addBotMessage(`오류가 발생했습니다.\n${error.message}`);
  } finally {
    setLoading(false);
  }
}

// 빠른 질문 버튼 처리
document.querySelectorAll("[data-question]").forEach((button) => {
  button.addEventListener("click", () => {
    sendQuestion(button.dataset.question);
  });
});

// 입력창 전송 처리
chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  sendQuestion(messageInput.value);
});

// 페이지 시작 시 날짜 표시
setDateLine();
