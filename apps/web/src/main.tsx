import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createHashHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import React from "react";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Workspace } from "./workspace.js";
import "streamdown/styles.css";
import "./style.css";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
const route = createRootRoute({ component: Workspace });
const router = createRouter({ routeTree: route, history: createHashHistory() });
const element = document.getElementById("root");
if (element)
	createRoot(element).render(
		<React.StrictMode>
			<QueryClientProvider client={queryClient}>
				<TooltipProvider delayDuration={400}>
					<RouterProvider router={router} />
				</TooltipProvider>
			</QueryClientProvider>
		</React.StrictMode>,
	);
