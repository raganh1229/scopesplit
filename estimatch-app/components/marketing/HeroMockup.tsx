"use client";

import Image from 'next/image';
import { useEffect, useState } from 'react';
import styles from '../../app/(marketing)/page.module.css';

const HERO_SLIDES = [
  '/Slide1.png?v=20260425e',
  '/Slide2.png?v=20260425c',
  '/Slide3.png?v=20260425b',
  '/Slide4.png?v=20260425d',
];

export default function HeroMockup() {
  const [activeSlide, setActiveSlide] = useState(0);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setActiveSlide((prev) => (prev + 1) % HERO_SLIDES.length);
    }, 12000);

    return () => window.clearTimeout(timeout);
  }, [activeSlide]);

  return (
    <div className={styles.heroMockup}>
      <div className={styles.heroBackdropPattern}>
        <div className={styles.heroBrowserWrap}>
          {HERO_SLIDES.map((slide, index) => (
            <Image
              key={slide}
              className={styles.heroBrowserScreenshot}
              src={slide}
              alt="ScopeSplit app comparison interface"
              fill
              sizes="(max-width: 768px) 100vw, 900px"
              unoptimized
              priority={index === 0}
              style={{ opacity: index === activeSlide ? 1 : 0, zIndex: index === activeSlide ? 2 : 1 }}
            />
          ))}

          <div className={styles.heroCarouselDots}>
            {HERO_SLIDES.map((slide, index) => (
              <button
                key={`${slide}-dot`}
                type="button"
                className={`${styles.heroCarouselDot} ${index === activeSlide ? styles.heroCarouselDotActive : ''}`}
                onClick={() => setActiveSlide(index)}
                aria-label={`Show slide ${index + 1}`}
                aria-pressed={index === activeSlide}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
