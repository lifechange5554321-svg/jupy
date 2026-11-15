import { createRoot } from "react-dom/client";
import { NotebookApp } from "../src/notebook/NotebookApp";
import "../src/styles.css";

const root = document.getElementById("root");
if (root) createRoot(root).render(<NotebookApp />);
