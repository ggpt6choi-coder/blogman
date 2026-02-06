# ==========================================
# [n8n & ngrok 재구동 명령어 모음]
# ==========================================

# 1. 기존 프로세스 깔끔하게 삭제 (충돌 방지)
pm2 delete ngrok
pm2 delete n8n

# 2. ngrok 인증 토큰 등록 (최초 1회만 필요, 토큰이 바뀐 경우 실행)
# ngrok 대시보드(dashboard.ngrok.com)에서 토큰 확인 후 아래에 붙여넣기
ngrok config add-authtoken [여기에_토큰_붙여넣기]

# 3. ngrok 실행 (포트 5678 오픈)
# ------------------------------------------
# [옵션 A] 일반 실행 (랜덤 주소 생성)
pm2 start "ngrok http 5678" --name ngrok

# [옵션 B] 고정 도메인 사용 시 (추천)
# 내 도메인이 'my-n8n.ngrok-free.dev'라면 아래 주석(#) 풀고 수정해서 실행
# pm2 start "ngrok http --domain=[내_고정_도메인] 5678" --name ngrok
# ------------------------------------------

# 4. n8n 실행
# ngrok 고정 도메인을 쓴다면 WEBHOOK_URL 환경변수를 같이 넣어주는 것이 좋음
# (일반 실행 시에는 그냥 'pm2 start n8n' 만 입력)
WEBHOOK_URL=https://[내_ngrok_주소] pm2 start n8n --name n8n

# 5. 상태 확인 및 현재 상태 저장 (재부팅 시 자동 실행)
pm2 list
pm2 save