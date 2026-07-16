import { useEffect, useState } from "react";
import Globe from "./Globe";

function BlinkingCursor() {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const id = setInterval(() => setOn((v) => !v), 530);
    return () => clearInterval(id);
  }, []);
  return (
    <span
      className="inline-block align-middle"
      style={{
        width: "0.6em",
        height: "1.05em",
        background: on ? "#e6d089" : "transparent",
        marginLeft: "2px",
      }}
    />
  );
}

function TypedLine({
  text,
  delay = 0,
  speed = 22,
  className = "",
}: {
  text: string;
  delay?: number;
  speed?: number;
  className?: string;
}) {
  const [shown, setShown] = useState("");
  useEffect(() => {
    let i = 0;
    let t: ReturnType<typeof setTimeout>;
    const start = setTimeout(() => {
      const step = () => {
        i++;
        setShown(text.slice(0, i));
        if (i < text.length) t = setTimeout(step, speed);
      };
      step();
    }, delay);
    return () => {
      clearTimeout(start);
      clearTimeout(t!);
    };
  }, [text, delay, speed]);
  return <span className={className}>{shown}</span>;
}

export default function App() {
  return (
    <div className="min-h-screen w-full bg-neutral-950 flex items-center justify-center p-6">
      {/* Terminal window */}
      <div
        className="w-full max-w-[900px] rounded-xl overflow-hidden shadow-2xl border border-white/5"
        style={{ background: "#111214" }}
      >
        {/* Title bar */}
        <div
          className="flex items-center px-4 py-2.5 border-b border-white/5"
          style={{ background: "#1a1b1e" }}
        >
          <div className="flex items-center gap-2">
            <span className="inline-block w-3 h-3 rounded-full bg-[#ff5f57]" />
            <span className="inline-block w-3 h-3 rounded-full bg-[#febc2e]" />
            <span className="inline-block w-3 h-3 rounded-full bg-[#28c840]" />
          </div>
          <div className="flex-1 flex justify-center items-center gap-2 text-xs text-neutral-400">
            <span className="text-[#5fa8ff]">▣</span>
            <span>amp</span>
          </div>
          <div className="w-14" />
        </div>

        {/* Terminal body */}
        <div className="px-8 pt-10 pb-6" style={{ background: "#111214" }}>
          <div className="flex items-start gap-10 min-h-[320px]">
            {/* Globe */}
            <div className="flex-shrink-0 pt-2">
              <Globe
                cols={44}
                rows={22}
                rotationSpeed={1.6}
                frameMs={110}
                tilt={20}
              />
            </div>

            {/* Right side text */}
            <div className="flex-1 pt-6 font-mono text-[13px] text-neutral-300 space-y-5 leading-relaxed">
              <div>
                <TypedLine
                  text="Welcome to Amp"
                  className="text-neutral-100"
                  delay={300}
                  speed={40}
                />
              </div>
              <div className="text-neutral-400">
                <span className="text-neutral-100 font-semibold">Ctrl+O</span>{" "}
                <TypedLine text="for help" delay={1000} speed={25} />
              </div>
              <div className="text-neutral-500 italic max-w-md">
                <TypedLine
                  text={
                    '"Wait, what do you mean? A completely rebuilt Amp CLI? They call it Neo? I have to see this."'
                  }
                  delay={1700}
                  speed={14}
                />
              </div>
            </div>
          </div>

          {/* Prompt bar */}
          <div className="mt-10 border-t border-white/5 pt-4">
            <div className="flex items-center justify-between text-xs font-mono text-neutral-500">
              <div />
              <div style={{ color: "#e6d089" }}>deep</div>
            </div>
            <div
              className="mt-3 rounded-md border px-3 py-2 flex items-center"
              style={{
                borderColor: "#e6d08933",
                background: "#14151799",
              }}
            >
              <BlinkingCursor />
            </div>
            <div className="mt-3 flex justify-end text-xs font-mono text-neutral-500">
              ~/work/globe
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
