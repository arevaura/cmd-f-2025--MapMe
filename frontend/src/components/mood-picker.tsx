"use client";

import { useState } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const moods = [
    { id: "excited", src: "/excited.png" },
    { id: "happy", src: "/happy.png" },
    { id: "neutral", src: "/neutral.png" },
    { id: "sad", src: "/sad.png" },
    { id: "angry", src: "/angry.png" },
];

export function MoodPicker({ className }: { className?: string }) {
  const [selectedMood, setSelectedMood] = useState<string | null>(null);

  return (
    <div className={`w-full ${className}`}>
      <ToggleGroup
        type="single"
        value={selectedMood || undefined}
        onValueChange={setSelectedMood}
        className="flex justify-between gap-3.5"
      >
        {moods.map((mood) => (
          <ToggleGroupItem
            key={mood.id}
            value={mood.id}
            className="overflow-hidden !p-0 !rounded-full w-11 h-11 transition duration-200 focus:outline-none !hover:bg-opacity-0 !hover:bg-white"
          >
            <img
              src={mood.src}
              alt={mood.id}
              className={`rounded-full object-cover transition-opacity duration-75 ${
                selectedMood === mood.id ? "opacity-100" : "opacity-30"
              }`}
            />
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}