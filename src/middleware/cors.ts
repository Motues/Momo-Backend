import cors from "@koa/cors"

const allowedOrigins: string[] = process.env.ALLOW_ORIGIN?.split(",") ?? [];
const CheckAllowOrigins = (requestOrigin: string) : string => {
  console.log(`Checking origin: ${requestOrigin}`);
  if(process.env.NODE_ENV === "development") {
    // console.log(`Development, allow origin: ${requestOrigin}`);
    return "*";
  }
  if (origin === "*" || allowedOrigins.includes(requestOrigin)) {
    console.log(`Allow origin: ${requestOrigin}`);
    return requestOrigin;
  }
  return "";
};

const corsMiddleware = cors({
    origin: (ctx) => CheckAllowOrigins(ctx.get("Origin")),
    credentials: true
});

export default corsMiddleware;