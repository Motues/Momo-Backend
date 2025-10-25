import "dotenv/config";
import Koa from "koa";
import bodyParser from "@koa/bodyparser"

import corsMiddleware  from "./middleware/cors";
import routerMiddleware from "./middleware/routes";

const app = new Koa();

app.use(corsMiddleware)
   .use(bodyParser())
   .use(routerMiddleware.routes())
   .use(routerMiddleware.allowedMethods());

app.listen(process.env.PORT);

console.log(`Server running on port ${process.env.PORT}`);
