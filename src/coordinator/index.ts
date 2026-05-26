import { createServer } from "./server";

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const app = createServer();

app.listen(PORT, () => {
	console.log(`Coordinator listening on port ${PORT}`);
});
