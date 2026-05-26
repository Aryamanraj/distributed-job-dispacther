import { logger } from "../util/logger";
import { createServer } from "./server";

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const app = createServer();

app.listen(PORT, () => {
	logger.info({ port: PORT }, "Coordinator listening");
});
