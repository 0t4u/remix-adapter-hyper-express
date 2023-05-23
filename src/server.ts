import type { MiddlewareHandler, Request, UserRouteHandler } from "hyper-express";
import LiveDirectory from "live-directory";
import type {
    ServerBuild,
    RequestInit as NodeRequestInit,
    Response as NodeResponse
} from "@remix-run/node";
import {
    AbortController as NodeAbortController,
    createRequestHandler as createRemixRequestHandler,
    Headers as NodeHeaders,
    Request as NodeRequest,
    writeReadableStreamToWritable,
} from "@remix-run/node";

export type GetLoadContextFunction = UserRouteHandler;

export type RequestHandler = MiddlewareHandler;

export function createRequestHandler({
    build,
    getLoadContext,
    mode = process.env.NODE_ENV,
    purgeRequireCache: enablePurgeRequireCache = true,
    serveStaticAssets: enableServeStaticAssets = true,
}: {
    build: string,
    getLoadContext?: GetLoadContextFunction,
    mode?: ServerBuild | string,
    purgeRequireCache?: boolean,
    serveStaticAssets?: boolean,
}): RequestHandler {
    let builtAssets: LiveDirectory;
    let publicAssets: LiveDirectory;

    if (enableServeStaticAssets) {
        builtAssets = new LiveDirectory(`${process.cwd()}/public/build`, {
            static: true
        });

        publicAssets = new LiveDirectory(`${process.cwd()}/public/`, {
            static: true,
            filter: {
                ignore(path) {
                    return path.startsWith("build");
                },
            }
        });
    }

    return async (request, response) => {
        try {
            const production = mode === "production";
            const environment = production ? mode : undefined;
            const serverBuild = (typeof build === "string") ? (await import(build)).default : build;
            const handleRequest = createRemixRequestHandler(serverBuild, environment);

            if (enablePurgeRequireCache && !production) {
                purgeRequireCache(build);
            }

            if (enableServeStaticAssets) {
                if (request.path.startsWith("/build")) {
                    const path = request.path.replace("/build", "");
                    const asset = builtAssets.get(path);
                    if (asset) {
                        const ONE_YEAR = 1 * 365 * 24 * 60 * 60;
                        response.header("Cache-Control", `max-age=${ONE_YEAR}`);

                        if (asset.cached) {
                            return response.send(asset.content);
                        } else {
                            const readable = asset.stream();
                            return readable.pipe(response);
                        }
                    }
                } else {
                    const asset = publicAssets.get(request.path);
                    if (asset) {
                        const ONE_HOUR = 1 * 60 * 60;
                        response.header("Cache-Control", `max-age=${ONE_HOUR}`);

                        if (asset.cached) {
                            return response.send(asset.content);
                        } else {
                            const readable = asset.stream();
                            return readable.pipe(response);
                        }
                    }
                }
            }

            const remixRequest = createRemixRequest(request, response);
            const loadContext = await getLoadContext?.(request, response);

            const remixResponse = await handleRequest(remixRequest, loadContext) as NodeResponse;

            await sendRemixResponse(response, remixResponse);
        } catch (error: unknown) {
            return error;
        }
    };
}

function purgeRequireCache(build: string) {
    for (const key in require.cache) {
        if (key.startsWith(build)) {
            delete require.cache[key];
        }
    }
}

export function createRemixHeaders(requestHeaders: Request["headers"]) {
    const headers = new NodeHeaders();

    for (const [key, values] of Object.entries(requestHeaders)) {
        if (values) {
            if (Array.isArray(values)) {
                for (const value of values) {
                    headers.append(key, value);
                }
            } else {
                headers.set(key, values);
            }
        }
    }

    return headers;
}

export function createRemixRequest(
    request: Parameters<RequestHandler>["0"],
    response: Parameters<RequestHandler>["1"]
): NodeRequest {
    const url = `${request.protocol}://${request.hostname}${request.url}`;

    const controller = new NodeAbortController();
    response.on("close", () => controller.abort());

    const init: NodeRequestInit = {
        method: request.method,
        headers: createRemixHeaders(request.headers),
        signal: controller.signal as NodeRequestInit["signal"]
    };

    if (request.method !== "GET" && request.method !== "HEAD") {
        init.body = request;
    }

    return new NodeRequest(url, init);
}

export async function sendRemixResponse(
    response: Parameters<RequestHandler>["1"],
    nodeResponse: NodeResponse
): Promise<void> {
    response.status(nodeResponse.status, nodeResponse.statusText);

    for (const [key, values] of Object.entries(nodeResponse.headers.raw())) {
        for (const value of values) {
            response.header(key, value, false);
        }
    }

    if (nodeResponse.body) {
        await writeReadableStreamToWritable(nodeResponse.body, response);
        response.send();
    } else {
        response.send();
    }
}
