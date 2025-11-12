declare global {
  namespace NodeJS {
    interface ProcessEnv {
      NODE_ENV: 'development' | 'production';
      PORT: string;
      DATABASE_URL: string;
      ALLOW_ORIGIN: string;
      RESEND_API_KEY: string;
      EMAIL_ADDRESS: string;
    }
  }
}