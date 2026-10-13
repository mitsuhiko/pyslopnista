# Tap the turtle before it runs away! The longer you play, the faster it gets.
# Shows a timer (ontimer) and taps (onclick). Tap ■ to stop the game.
import random

import turtle

screen = turtle.Screen()
screen.title("Catch the Turtle")
screen.bgcolor("pale green")

score = 0

# A turtle that never shows itself, just to write the score.
board = turtle.Turtle(visible=False)
board.penup()
board.goto(0, 240)


def show_score():
    board.clear()
    board.write(f"Score: {score}", align="center", font=("Arial", 28, "bold"))


player = turtle.Turtle(shape="turtle")
player.color("dark green")
player.shapesize(2.5)  # bigger, so it is easier to tap
player.penup()
player.speed(0)


def jump():
    player.goto(random.randint(-240, 240), random.randint(-240, 190))
    player.setheading(random.randint(0, 359))


def tick():
    jump()
    wait = max(450, 1300 - score * 60)  # milliseconds
    screen.ontimer(tick, wait)


def caught(x, y):
    global score
    score += 1
    show_score()
    jump()


show_score()
player.onclick(caught)
tick()
turtle.done()  # keep handling taps until you stop the program
