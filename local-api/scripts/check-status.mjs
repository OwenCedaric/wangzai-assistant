const baseUrl = process.env.LOCAL_API_BASE_URL || 'http://127.0.0.1:3790';

const response = await fetch(`${baseUrl}/api/app/status`, {
  method: 'GET',
  headers: {
    accept: 'application/json',
    'x-wangzai-local-api': 'status-check',
  },
});

const text = await response.text();

if (!response.ok) {
  console.error(text);
  process.exit(1);
}

console.log(text);
