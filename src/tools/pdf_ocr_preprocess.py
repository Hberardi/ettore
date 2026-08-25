#!/usr/bin/env python3
"""Prepare difficult scanned pages for Tesseract without extra Python packages."""

import sys

from PIL import Image, ImageFilter, ImageOps


def preprocess(source, target):
    image = Image.open(source).convert("L")
    if max(image.size) < 2200:
        scale = 2200 / max(image.size)
        image = image.resize((int(image.width * scale), int(image.height * scale)), Image.Resampling.LANCZOS)

    image = ImageOps.autocontrast(image, cutoff=1)
    try:
        import cv2
        import numpy as np

        pixels = np.array(image)
        pixels = cv2.fastNlMeansDenoising(pixels, None, 7, 7, 21)

        # Estimate a small page skew from dark pixels and rotate it out.
        _, skew_mask = cv2.threshold(pixels, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
        coords = np.column_stack(np.where(skew_mask > 0))
        if len(coords) > 100:
            angle = cv2.minAreaRect(coords)[-1]
            angle = -(90 + angle) if angle < -45 else -angle
            if 0.15 < abs(angle) < 12:
                height, width = pixels.shape
                matrix = cv2.getRotationMatrix2D((width / 2, height / 2), angle, 1.0)
                pixels = cv2.warpAffine(pixels, matrix, (width, height), borderMode=cv2.BORDER_REPLICATE)

        # Adaptive threshold keeps faint text while removing uneven paper shade.
        binary = cv2.adaptiveThreshold(
            pixels, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 15
        )
        Image.fromarray(binary).save(target, format="PNG", optimize=True)
        return
    except Exception:
        # Pillow-only fallback remains useful on minimal installations.
        image = image.filter(ImageFilter.MedianFilter(size=3))
        image = image.point(lambda value: 255 if value > 170 else 0)
        image.save(target, format="PNG", optimize=True)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: pdf_ocr_preprocess.py INPUT OUTPUT")
    preprocess(sys.argv[1], sys.argv[2])
