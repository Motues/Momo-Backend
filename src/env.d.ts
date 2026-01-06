declare global {
  namespace NodeJS {
    interface ProcessEnv {
      NODE_ENV: 'development' | 'production';
      PORT: string;
      DATABASE_URL: string;
      ALLOW_ORIGIN: string;
      RESEND_API_KEY: string;
      RESEND_FROM_EMAIL: string;
      EMAIL_ADDRESS: string;
      ADMIN_NAME: string;
      ADMIN_PASSWORD: string;
    }
  }
}