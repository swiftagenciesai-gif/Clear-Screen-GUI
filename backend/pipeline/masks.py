"""Foreground masking from a plain background-plate photo.

COLMAP's ImageReader accepts a mask directory where each mask is named
"<image_filename>.png" and stored with the same pixel dimensions as the
photo. By COLMAP convention, pixels with value 0 are IGNORED during feature
extraction/matching, and non-zero pixels are used. See:
https://colmap.github.io/faq.html#mask-image-regions

We build masks by comparing every turntable photo against the background
plate: large per-pixel differences are treated as "object", small ones as
"background/turntable surface" and masked out. This is a simple but
effective way to stop COLMAP from wasting matches on a static background,
which otherwise confuses the reconstruction (a static background looks like
an infinitely-far, non-moving scene to the SfM solver).
"""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np


def build_masks(
    raw_dir: Path,
    background_path: Path | None,
    masks_dir: Path,
    diff_threshold: int = 25,
    dilate_px: int = 9,
) -> int:
    """Write one mask per image in raw_dir. Returns number of masks written.

    If background_path is None, masks_dir is left empty and COLMAP simply
    uses full-frame images (no masking) -- still works, just less clean.
    """
    masks_dir.mkdir(parents=True, exist_ok=True)
    if background_path is None or not background_path.exists():
        return 0

    bg = cv2.imread(str(background_path), cv2.IMREAD_COLOR)
    if bg is None:
        return 0
    bg_gray = cv2.cvtColor(bg, cv2.COLOR_BGR2GRAY)
    bg_gray = cv2.GaussianBlur(bg_gray, (5, 5), 0)

    count = 0
    for img_path in sorted(raw_dir.iterdir()):
        if img_path.suffix.lower() not in (".jpg", ".jpeg", ".png"):
            continue
        img = cv2.imread(str(img_path), cv2.IMREAD_COLOR)
        if img is None:
            continue
        if img.shape[:2] != bg.shape[:2]:
            bg_resized = cv2.resize(bg_gray, (img.shape[1], img.shape[0]))
        else:
            bg_resized = bg_gray

        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        gray = cv2.GaussianBlur(gray, (5, 5), 0)

        diff = cv2.absdiff(gray, bg_resized)
        _, mask = cv2.threshold(diff, diff_threshold, 255, cv2.THRESH_BINARY)

        # Clean up: close small holes inside the object, remove speckle noise,
        # then dilate slightly so we don't clip the object's silhouette edge
        # (COLMAP features right at a hard mask boundary are unreliable).
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=2)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel, iterations=1)
        if dilate_px > 0:
            dilate_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (dilate_px, dilate_px))
            mask = cv2.dilate(mask, dilate_kernel)

        # Keep only the largest connected component (the object), drop stray
        # noise blobs elsewhere in the frame.
        num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
        if num_labels > 1:
            largest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
            mask = np.where(labels == largest, 255, 0).astype(np.uint8)

        out_path = masks_dir / f"{img_path.name}.png"
        cv2.imwrite(str(out_path), mask)
        count += 1
    return count
